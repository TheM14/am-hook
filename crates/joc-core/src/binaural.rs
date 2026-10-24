//! Binaural runtime: 16-channel objects in, stereo out.
//!
//! The runtime stages the object frame into 512-sample blocks (the renderer's
//! granularity), advances the OAMD position timeline per block, and keeps the
//! rendered samples minus the 961-sample kernel latency.  It is a port of the
//! reference `SofaBinauralRuntime`.

use crate::jochrtf::{Field, Kernels};
use crate::oamd::OamdUpdate;
use crate::sofa_binaural::{self, BinauralRenderer, RoomConstants};
use crate::timeline::OamdPositionTimeline;
use crate::{fail, ErrorKind, Result, BINAURAL_BLOCK_SAMPLES, FRAME_SAMPLES};

const SOURCE_COUNT: usize = 16;
const OBJECTS: usize = SOURCE_COUNT - 1;
const LFE_POSITION: [f64; 3] = [0.0, 1.0, 0.0];

/// What the listener hears, for the visualisation: the 15 objects' ADM positions (before the
/// height scale) at the last block, and the RMS level of the LFE and each object since the last
/// [`BinauralRuntime::take_scene`].
#[derive(Clone, Copy)]
pub struct Scene {
    pub positions: [[f64; 3]; OBJECTS],
    pub levels: [f64; SOURCE_COUNT],
}

/// Interactive controls (an am-hook extension, not in the reference); the defaults render exactly
/// as the reference does.
#[derive(Clone, Copy, PartialEq)]
pub struct Controls {
    /// World -> head rotation (`sofa_binaural::head_rotation`)
    pub head: [[f64; 3]; 3],
    /// The listener's offset from the listening position, in metres
    pub walk: [f64; 3],
    /// Linear gain of the LFE (0) and of each object (1..=15): solo and mute
    pub gains: [f64; SOURCE_COUNT],
    /// 0 = off; 1 = objects in front of the face are 6 dB louder and the rest up to 15 dB quieter
    pub focus: f64,
    /// Elevation scale for the objects' height (1 = as mixed)
    pub height: f64,
}

impl Default for Controls {
    fn default() -> Self {
        Self {
            head: sofa_binaural::head_rotation(0.0, 0.0, 0.0),
            walk: [0.0; 3],
            gains: [1.0; SOURCE_COUNT],
            focus: 0.0,
            height: 1.0,
        }
    }
}

pub struct BinauralRuntime {
    renderer: BinauralRenderer,
    profile: u32,
    timeline: OamdPositionTimeline,
    staging: Vec<f64>,
    staged: usize,
    block_output: Vec<f64>,
    output: Vec<f64>,
    input_samples: u64,
    processed_samples: i64,
    blocks_processed: u64,
    hrtf_history_slots: u32,
    tail_samples: u32,
    controls: Controls,
    scene_positions: [[f64; 3]; OBJECTS],
    scene_energy: [f64; SOURCE_COUNT],
    scene_samples: u64,
}

impl Default for BinauralRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl BinauralRuntime {
    pub fn new() -> Self {
        Self {
            renderer: BinauralRenderer::new(),
            profile: 1,
            timeline: OamdPositionTimeline::new(),
            staging: Vec::new(),
            staged: 0,
            block_output: Vec::new(),
            output: Vec::new(),
            input_samples: 0,
            processed_samples: 0,
            blocks_processed: 0,
            hrtf_history_slots: 1,
            tail_samples: 61200,
            controls: Controls::default(),
            scene_positions: [[0.0, 1.0, 0.0]; OBJECTS],
            scene_energy: [0.0; SOURCE_COUNT],
            scene_samples: 0,
        }
    }

    pub fn open(&mut self, field: &Field, kernels: &Kernels, profile: u32) -> Result<()> {
        self.renderer.configure_kernels(kernels)?;
        self.renderer.configure_field(field)?;
        self.renderer.configure_room(&RoomConstants::default())?;
        self.renderer.set_listener_pose(&self.controls.head, &self.controls.walk);
        self.profile = profile;
        let maximum = field
            .delay_bounds
            .iter()
            .copied()
            .fold(0.0f64, f64::max);
        let maximum_delay = (maximum - 1e-9).ceil() as i64;
        self.hrtf_history_slots = ((maximum_delay + 63) / 64).max(1) as u32;
        self.staging = vec![0.0; BINAURAL_BLOCK_SAMPLES * SOURCE_COUNT];
        self.block_output = vec![0.0; BINAURAL_BLOCK_SAMPLES * 2];
        self.output.clear();
        self.staged = 0;
        self.input_samples = 0;
        self.processed_samples = 0;
        self.blocks_processed = 0;
        Ok(())
    }

    pub fn reset(&mut self) {
        self.renderer.reset();
        self.timeline = OamdPositionTimeline::new();
        self.scene_energy = [0.0; SOURCE_COUNT];
        self.scene_samples = 0;
        self.output.clear();
        self.staged = 0;
        self.input_samples = 0;
        self.processed_samples = 0;
        self.blocks_processed = 0;
    }

    pub fn submit_frame(
        &mut self,
        objects16: &[f32],
        update: Option<&OamdUpdate>,
        frame_index: i64,
        outer_sample_offset: i64,
        object_delay_samples: i64,
    ) -> Result<()> {
        if objects16.len() < SOURCE_COUNT * FRAME_SAMPLES {
            return fail(ErrorKind::InvalidArgument, "render", "null frame");
        }
        if let Some(update) = update {
            self.timeline.submit_update(
                update,
                frame_index * FRAME_SAMPLES as i64,
                outer_sample_offset,
                object_delay_samples,
                self.input_samples as i64,
            )?;
        }
        let mut offset = 0usize;
        while offset < FRAME_SAMPLES {
            let room = BINAURAL_BLOCK_SAMPLES - self.staged;
            let count = room.min(FRAME_SAMPLES - offset);
            for sample in 0..count {
                let row = (self.staged + sample) * SOURCE_COUNT;
                for channel in 0..SOURCE_COUNT {
                    self.staging[row + channel] =
                        f64::from(objects16[channel * FRAME_SAMPLES + offset + sample]);
                }
            }
            self.staged += count;
            offset += count;
            if self.staged == BINAURAL_BLOCK_SAMPLES {
                self.process_block()?;
            }
        }
        self.input_samples += FRAME_SAMPLES as u64;
        Ok(())
    }

    /// Applies the interactive controls from the next block on (the pose through the renderer's
    /// per-source crossfade).
    pub fn set_controls(&mut self, controls: &Controls) {
        if controls.head != self.controls.head || controls.walk != self.controls.walk {
            self.renderer.set_listener_pose(&controls.head, &controls.walk);
        }
        self.controls = *controls;
        self.controls.walk = self.renderer.walk();
        self.controls.focus = if controls.focus.is_finite() { controls.focus.clamp(0.0, 1.0) } else { 0.0 };
        self.controls.height = if controls.height.is_finite() { controls.height.clamp(0.0, 4.0) } else { 1.0 };
        for gain in &mut self.controls.gains {
            *gain = if gain.is_finite() { gain.clamp(0.0, 4.0) } else { 1.0 };
        }
    }

    pub fn controls(&self) -> Controls {
        self.controls
    }

    /// The objects' positions at the last block and their levels since the previous call.
    pub fn take_scene(&mut self) -> Scene {
        let mut levels = [0.0f64; SOURCE_COUNT];
        if self.scene_samples > 0 {
            for channel in 0..SOURCE_COUNT {
                levels[channel] = (self.scene_energy[channel] / self.scene_samples as f64).sqrt();
            }
        }
        self.scene_energy = [0.0; SOURCE_COUNT];
        self.scene_samples = 0;
        Scene { positions: self.scene_positions, levels }
    }

    /// The focus gain of an object at an ADM position: by the angle between the face and the
    /// object as seen from where the listener stands.
    fn focus_gain(&self, position: &[f64; 3]) -> f64 {
        let focus = self.controls.focus;
        if focus == 0.0 {
            return 1.0;
        }
        let offset = sofa_binaural::source_offset(position, self.profile);
        let walk = self.controls.walk;
        let vector = [offset[0] - walk[0], offset[1] - walk[1], offset[2] - walk[2]];
        let length = (vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]).sqrt();
        if length < 1.0e-9 {
            return 10f64.powf(6.0 * focus / 20.0);
        }
        // The face points along the head's +Y: the second row of the world -> head rotation
        let face = self.controls.head[1];
        let cosine = (face[0] * vector[0] + face[1] * vector[1] + face[2] * vector[2]) / length;
        let weight = ((cosine + 1.0) / 2.0).powi(4);
        10f64.powf(focus * (-15.0 + 21.0 * weight) / 20.0)
    }

    fn process_block(&mut self) -> Result<()> {
        let mut positions = self
            .timeline
            .positions_at(self.processed_samples)?;
        self.scene_positions = positions;
        for sample in 0..BINAURAL_BLOCK_SAMPLES {
            let row = sample * SOURCE_COUNT;
            for channel in 0..SOURCE_COUNT {
                let value = self.staging[row + channel];
                self.scene_energy[channel] += value * value;
            }
        }
        self.scene_samples += BINAURAL_BLOCK_SAMPLES as u64;
        let height = self.controls.height;
        if height != 1.0 {
            for position in &mut positions {
                position[2] = (position[2] * height).clamp(-1.0, 1.0);
            }
        }
        // The reference sets every source on every block and relies on the
        // per-object crossfade, so `fade` is on.
        let fade = true;
        self.renderer.set_source(
            0,
            &LFE_POSITION,
            self.profile,
            self.controls.gains[0],
            true,
            true,
            fade,
        )?;
        for source in 0..OBJECTS {
            let gain = self.controls.gains[source + 1] * self.focus_gain(&positions[source]);
            self.renderer.set_source(
                source + 1,
                &positions[source],
                self.profile,
                gain,
                true,
                false,
                fade,
            )?;
        }
        let produced = self.renderer.process(
            &self.staging,
            BINAURAL_BLOCK_SAMPLES,
            1.0,
            &mut self.block_output,
        )?;
        if produced > 0 {
            self.output.extend_from_slice(&self.block_output[..produced * 2]);
        }
        self.staged = 0;
        self.processed_samples += BINAURAL_BLOCK_SAMPLES as i64;
        self.blocks_processed += 1;
        Ok(())
    }

    /// Rendered samples that have not been taken yet.
    pub fn take_output(&mut self, out: &mut Vec<f64>) {
        out.append(&mut self.output);
    }

    pub fn finish_capacity(&self, tail_seconds: f64) -> u32 {
        let mut requested = self.tail_samples as i64;
        if tail_seconds >= 0.0 {
            requested = (tail_seconds * 48000.0 - 1e-9).ceil() as i64;
        }
        let hrtf_bound = i64::from(self.hrtf_history_slots) * 64;
        let early_bound = hrtf_bound + 2048 + 256 * 64;
        let mut drain = requested.max(early_bound) + 961;
        drain = ((drain + 63) / 64) * 64;
        drain.max(0) as u32
    }

    pub fn finish(&mut self, mut flush_samples: u32, out: &mut Vec<f64>) -> Result<()> {
        out.clear();
        if flush_samples == 0 {
            return Ok(());
        }
        let mut chunk = vec![0.0f64; BINAURAL_BLOCK_SAMPLES * 2];
        while flush_samples > 0 {
            let request = flush_samples.min(BINAURAL_BLOCK_SAMPLES as u32) as usize;
            let produced = self.renderer.finish(request, &mut chunk)?;
            if produced == 0 {
                break;
            }
            out.extend_from_slice(&chunk[..produced * 2]);
            flush_samples -= produced as u32;
        }
        Ok(())
    }
}

