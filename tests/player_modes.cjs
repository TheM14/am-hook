const assert = require('node:assert/strict');
const { test } = require('node:test');
const { detectModes, useJocSettings, sortVariants } = require('../src/ui/player.js');

test('EC-3 chooses MSE before PCM regardless of browser', () => {
  global.Worker = function Worker() {};
  global.AudioContext = function AudioContext() {};
  global.WebAssembly = WebAssembly;
  global.AmDecrypt = { supported: () => true };
  global.MediaSource = { isTypeSupported: () => true };
  global.navigator = { vendor: 'Google Inc.' };
  assert.deepEqual(detectModes('ec-3'), ['mse', 'ec3']);
  global.navigator.vendor = 'Apple Computer, Inc.';
  assert.deepEqual(detectModes('ec-3'), ['mse', 'ec3']);
});

test('EC-3 selects PCM when native playback is unavailable', () => {
  global.Worker = function Worker() {};
  global.AudioContext = function AudioContext() {};
  global.AmDecrypt = { supported: () => true };
  global.MediaSource = { isTypeSupported: () => false };
  assert.deepEqual(detectModes('ec-3'), ['ec3']);
});

test('JOC object rendering comes first for EC-3 when enabled: binaural, then Speaker 2.0, then the usual modes', () => {
  global.Worker = function Worker() {};
  global.AudioContext = function AudioContext() {};
  global.AmDecrypt = { supported: () => true };
  global.MediaSource = { isTypeSupported: () => true };
  let settings = { mode: 'binaural', gain: 0, dataset: 'D2' };
  useJocSettings({ get: () => settings, set: () => {} });
  try {
    assert.deepEqual(detectModes('ec-3'), ['jocbin', 'joc2', 'mse', 'ec3']);
    settings = { ...settings, mode: 'speaker' };
    assert.deepEqual(detectModes('ec-3'), ['joc2', 'mse', 'ec3']);
    // only E-AC-3 is affected
    assert.deepEqual(detectModes('alac'), ['mse', 'flac']);
    settings = { ...settings, mode: 'off' };
    assert.deepEqual(detectModes('ec-3'), ['mse', 'ec3']);
    // JOC needs the same Worker / WebAssembly / Web Audio support as the PCM fallback
    settings = { ...settings, mode: 'speaker' };
    global.AudioContext = undefined;
    assert.deepEqual(detectModes('ec-3'), ['mse']);
  } finally {
    useJocSettings(null);
  }
});

test('the queue prefers Dolby Atmos over ALAC only while JOC rendering is on', () => {
  const variants = [
    { group_id: 'audio-stereo-256', bandwidth: 256000 },
    { group_id: 'audio-atmos-2768', bandwidth: 768000 },
    { group_id: 'audio-alac-stereo-48000-24', bandwidth: 2000000 },
  ];
  const order = () => sortVariants(variants).map((v) => v.group_id.split('-')[1]);
  assert.deepEqual(order(), ['alac', 'atmos', 'stereo']);
  useJocSettings({ get: () => ({ mode: 'speaker', gain: 0, dataset: 'D2' }), set: () => {} });
  try {
    assert.deepEqual(order(), ['atmos', 'alac', 'stereo']);
  } finally {
    useJocSettings(null);
  }
});
