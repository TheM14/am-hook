//! Widevine license challenge generation and content-key extraction.
//!
//! A port of the Widevine CDM of apple-music-downloader
//! (`internal/widevine-rip/cdm` and `pssh.go`, commit
//! 487f705cdb693b194fe8dfedafd1064ea6570d05), with its built-in device. Only
//! the license-acquisition path without privacy mode is included, which is
//! what Apple's license servers (directly or through wrapper-lite) accept.
//!
//! The session API mirrors [`crate::playready::Cdm`]: open a session, build a
//! challenge, parse the license, close.

use std::collections::HashMap;

use rand_core::RngCore;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::{Oaep, Pss, RsaPrivateKey};
use sha1::{Digest, Sha1};

use crate::crypto::{base64_decode, cmac, Aes};
use crate::playready::Entropy;
use crate::{bail, Error, Result};

/// Widevine DRM system ID in `pssh` boxes.
pub const SYSTEM_ID: [u8; 16] = [0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce, 0xa3, 0xc8, 0x27, 0xdc, 0xd5, 0x1d, 0x21, 0xed];

/// The reference downloader's built-in device, as a pywidevine `.wvd` (v2) file.
const DEFAULT_DEVICE: &str = include_str!("default_widevine_device.b64");

// Message and enum values of license_protocol.proto that the request uses.
const LICENSE_TYPE_DEFAULT: u64 = 1;
const REQUEST_TYPE_NEW: u64 = 1;
const PROTOCOL_VERSION_2_1: u64 = 21;
const MESSAGE_TYPE_LICENSE_REQUEST: u64 = 1;
const KEY_TYPE_CONTENT: u64 = 2;
const ALGORITHM_AESCTR: u64 = 1;

/// Minimal protobuf wire format: only what the license request and response need.
mod proto {
    use crate::{Error, Result};

    pub fn varint(out: &mut Vec<u8>, mut v: u64) {
        while v >= 0x80 {
            out.push(v as u8 | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }

    pub fn uint(out: &mut Vec<u8>, field: u32, v: u64) {
        varint(out, (field as u64) << 3);
        varint(out, v);
    }

    pub fn bytes(out: &mut Vec<u8>, field: u32, v: &[u8]) {
        varint(out, (field as u64) << 3 | 2);
        varint(out, v.len() as u64);
        out.extend_from_slice(v);
    }

    pub enum Value<'a> {
        Varint(u64),
        Bytes(&'a [u8]),
        /// 32- and 64-bit fixed fields, kept only to be skipped.
        Fixed,
    }

    fn read_varint(data: &[u8], pos: &mut usize) -> Result<u64> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let b = *data.get(*pos).ok_or_else(|| Error::new("truncated protobuf varint"))?;
            *pos += 1;
            v |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(Error::new("protobuf varint is too long"))
    }

    /// Every field of a message, in wire order.
    pub fn fields(data: &[u8]) -> Result<Vec<(u32, Value<'_>)>> {
        let mut out = Vec::new();
        let mut pos = 0;
        while pos < data.len() {
            let tag = read_varint(data, &mut pos)?;
            let field = (tag >> 3) as u32;
            let skip = |pos: &mut usize, n: usize| -> Result<()> {
                if data.len() - *pos < n {
                    return Err(Error::new("truncated protobuf field"));
                }
                *pos += n;
                Ok(())
            };
            let value = match tag & 7 {
                0 => Value::Varint(read_varint(data, &mut pos)?),
                1 => {
                    skip(&mut pos, 8)?;
                    Value::Fixed
                }
                2 => {
                    let n = usize::try_from(read_varint(data, &mut pos)?).map_err(|_| Error::new("invalid protobuf length"))?;
                    let start = pos;
                    skip(&mut pos, n)?;
                    Value::Bytes(&data[start..pos])
                }
                5 => {
                    skip(&mut pos, 4)?;
                    Value::Fixed
                }
                w => return Err(Error::msg(format!("unsupported protobuf wire type {w}"))),
            };
            out.push((field, value));
        }
        Ok(out)
    }

    /// The last occurrence of a length-delimited field (protobuf "last one wins").
    pub fn last_bytes<'a>(fields: &[(u32, Value<'a>)], field: u32) -> Option<&'a [u8]> {
        fields.iter().rev().find_map(|(f, v)| match v {
            Value::Bytes(b) if *f == field => Some(*b),
            _ => None,
        })
    }

    pub fn last_varint(fields: &[(u32, Value<'_>)], field: u32) -> Option<u64> {
        fields.iter().rev().find_map(|(f, v)| match v {
            Value::Varint(n) if *f == field => Some(*n),
            _ => None,
        })
    }
}

pub struct Device {
    key: RsaPrivateKey,
    /// Serialized ClientIdentification.
    client_id: Vec<u8>,
}

impl Device {
    pub fn default_device() -> Result<Device> {
        let data = base64_decode(DEFAULT_DEVICE.trim()).ok_or_else(|| Error::new("invalid default Widevine device"))?;
        Device::parse(&data)
    }

    /// Parses a pywidevine `.wvd` file (version 2: a PKCS#1 DER private key and
    /// a serialized ClientIdentification).
    pub fn parse(data: &[u8]) -> Result<Device> {
        if data.len() < 9 || &data[..3] != b"WVD" {
            bail!("invalid WVD header");
        }
        if data[3] != 2 {
            bail!("unsupported WVD version {}", data[3]);
        }
        let mut pos = 7;
        let mut field = || -> Result<&[u8]> {
            let n = data.get(pos..pos + 2).map(|b| u16::from_be_bytes([b[0], b[1]]) as usize).ok_or_else(|| Error::new("truncated WVD"))?;
            let value = data.get(pos + 2..pos + 2 + n).ok_or_else(|| Error::new("truncated WVD"))?;
            pos += 2 + n;
            Ok(value)
        };
        let key = RsaPrivateKey::from_pkcs1_der(field()?).map_err(|_| Error::new("invalid Widevine device private key"))?;
        let client_id = field()?.to_vec();
        if client_id.is_empty() {
            bail!("empty Widevine client ID");
        }
        Ok(Device { key, client_id })
    }
}

/// The WidevinePsshData (`WidevineCencHeader`) the reference builds for a key
/// ID taken from an HLS key URI (`BuildPSSH` with an empty content ID).
pub fn cenc_header_for_kid(kid: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    proto::uint(&mut out, 1, ALGORITHM_AESCTR);
    proto::bytes(&mut out, 2, kid);
    proto::bytes(&mut out, 3, b""); // provider
    proto::bytes(&mut out, 4, b""); // content_id: base64 of the empty content ID
    proto::bytes(&mut out, 6, b""); // policy
    out
}

/// WidevinePsshData for an HLS Widevine key payload: the data of a Widevine
/// `pssh` box, or else a key ID (what Apple puts in its key URIs).
pub fn cenc_header(payload: &[u8]) -> Result<Vec<u8>> {
    if payload.len() >= 32 && &payload[4..8] == b"pssh" {
        if payload[12..28] != SYSTEM_ID {
            bail!("pssh box is not a Widevine pssh");
        }
        let be = |at: usize| u32::from_be_bytes(payload[at..at + 4].try_into().unwrap()) as usize;
        let mut pos = 28;
        if payload[8] == 1 {
            pos += 4 + 16 * be(pos);
        }
        let data = payload.get(pos + 4..).and_then(|rest| rest.get(..be(pos))).ok_or_else(|| Error::new("truncated Widevine pssh box"))?;
        return Ok(data.to_vec());
    }
    if payload.is_empty() {
        bail!("empty Widevine key ID");
    }
    Ok(cenc_header_for_kid(payload))
}

struct Session {
    /// RequestId: 16 random upper-case hex characters, "01", zero padding (as Chrome CDMs do).
    request_id: [u8; 32],
    /// The serialized LicenseRequest last signed in this session; the key that
    /// wraps the content keys is derived from these exact bytes.
    request: Option<Vec<u8>>,
}

pub struct Cdm {
    device: Device,
    sessions: HashMap<String, Session>,
}

impl Cdm {
    pub fn new(device: Device) -> Cdm {
        Cdm { device, sessions: HashMap::new() }
    }

    pub fn open(&mut self, rng: &mut Entropy) -> String {
        const HEX: &[u8; 16] = b"ABCDEF0123456789";
        let mut random = [0u8; 16];
        rng.fill_bytes(&mut random);
        let mut request_id = [b'0'; 32];
        for (dst, r) in request_id.iter_mut().zip(random) {
            *dst = HEX[(r & 15) as usize];
        }
        request_id[16..18].copy_from_slice(b"01");
        let id = String::from_utf8(request_id.to_vec()).unwrap();
        self.sessions.insert(id.clone(), Session { request_id, request: None });
        id
    }

    pub fn close(&mut self, session: &str) {
        self.sessions.remove(session);
    }

    pub fn has(&self, session: &str) -> bool {
        self.sessions.contains_key(session)
    }

    /// Serialized SignedLicenseRequest for a WidevinePsshData. `now` is the Unix time in seconds.
    pub fn license_challenge(&mut self, session: &str, cenc_header: &[u8], now: u64, rng: &mut Entropy) -> Result<Vec<u8>> {
        let sess = self.sessions.get_mut(session).ok_or_else(|| Error::new("invalid CDM session"))?;
        let mut cenc = Vec::new();
        proto::bytes(&mut cenc, 1, cenc_header);
        proto::uint(&mut cenc, 2, LICENSE_TYPE_DEFAULT);
        proto::bytes(&mut cenc, 3, &sess.request_id);
        let mut content_id = Vec::new();
        proto::bytes(&mut content_id, 1, &cenc);

        let mut msg = Vec::new();
        proto::bytes(&mut msg, 1, &self.device.client_id);
        proto::bytes(&mut msg, 2, &content_id);
        proto::uint(&mut msg, 3, REQUEST_TYPE_NEW);
        proto::uint(&mut msg, 4, now as u32 as u64);
        proto::uint(&mut msg, 6, PROTOCOL_VERSION_2_1);
        // The reference draws the nonce below MaxUint32.
        proto::uint(&mut msg, 7, (rng.next_u32() % u32::MAX) as u64);

        let hash = Sha1::digest(&msg);
        let signature = self.device.key.sign_with_rng(rng, Pss::new::<Sha1>(), &hash).map_err(|_| Error::new("RSA-PSS signing failed"))?;
        let mut signed = Vec::new();
        proto::uint(&mut signed, 1, MESSAGE_TYPE_LICENSE_REQUEST);
        proto::bytes(&mut signed, 2, &msg);
        proto::bytes(&mut signed, 3, &signature);
        sess.request = Some(msg);
        Ok(signed)
    }

    /// Decrypts the content keys of a serialized SignedLicense, as (key ID, key).
    pub fn parse_license(&self, session: &str, license: &[u8]) -> Result<Vec<(Vec<u8>, [u8; 16])>> {
        let sess = self.sessions.get(session).ok_or_else(|| Error::new("invalid CDM session"))?;
        let request = sess.request.as_deref().ok_or_else(|| Error::new("no license request in this session"))?;
        let signed = proto::fields(license).map_err(|e| e.context("parse license response"))?;
        let session_key = proto::last_bytes(&signed, 4).ok_or_else(|| Error::new("license has no session key"))?;
        let session_key = self.device.key.decrypt(Oaep::new::<Sha1>(), session_key).map_err(|_| Error::new("decrypt license session key"))?;
        let session_key: [u8; 16] = session_key.try_into().map_err(|_| Error::new("invalid license session key"))?;
        let aes = Aes::new(&derive_encryption_key(&session_key, request));

        let msg = proto::fields(proto::last_bytes(&signed, 2).unwrap_or_default()).map_err(|e| e.context("parse license"))?;
        let mut keys = Vec::new();
        for (field, value) in &msg {
            let proto::Value::Bytes(container) = value else { continue };
            if *field != 3 {
                continue;
            }
            let container = proto::fields(container).map_err(|e| e.context("parse key container"))?;
            if proto::last_varint(&container, 4) != Some(KEY_TYPE_CONTENT) {
                continue;
            }
            let iv: [u8; 16] = proto::last_bytes(&container, 2)
                .and_then(|iv| iv.try_into().ok())
                .ok_or_else(|| Error::new("key container IV must be 16 bytes"))?;
            let mut key = proto::last_bytes(&container, 3).unwrap_or_default().to_vec();
            if key.is_empty() || !key.len().is_multiple_of(16) {
                bail!("key container has invalid length {}", key.len());
            }
            aes.cbc_decrypt(&mut key, &mut iv.clone());
            let key = pkcs7_unpad(&key)?;
            let key: [u8; 16] = key.try_into().map_err(|_| Error::new("content key is not 128 bits"))?;
            keys.push((proto::last_bytes(&container, 1).unwrap_or_default().to_vec(), key));
        }
        Ok(keys)
    }
}

/// AES-CMAC(sessionKey, 0x01 || "ENCRYPTION" || 0x00 || request || 128 as u32 BE).
fn derive_encryption_key(session_key: &[u8; 16], request: &[u8]) -> [u8; 16] {
    let mut context = Vec::with_capacity(request.len() + 16);
    context.push(1);
    context.extend_from_slice(b"ENCRYPTION\0");
    context.extend_from_slice(request);
    context.extend_from_slice(&128u32.to_be_bytes());
    cmac(session_key, &context)
}

fn pkcs7_unpad(data: &[u8]) -> Result<&[u8]> {
    let n = *data.last().ok_or_else(|| Error::new("pkcs7: empty data"))? as usize;
    if n == 0 || n > 16 || n > data.len() || data[data.len() - n..].iter().any(|&b| b as usize != n) {
        bail!("pkcs7: invalid padding");
    }
    Ok(&data[..data.len() - n])
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::traits::PublicKeyParts;
    use rsa::RsaPublicKey;

    fn counter_rng() -> impl FnMut(&mut [u8]) {
        let mut n = 0u8;
        move |buf: &mut [u8]| {
            for b in buf {
                n = n.wrapping_mul(31).wrapping_add(7);
                *b = n;
            }
        }
    }

    #[test]
    fn cenc_header_matches_reference() {
        // BuildPSSH("AAAAAF2JT1MAHfdbtyOvVQ==", "") marshals algorithm, key_id, provider, content_id, policy.
        let kid = base64_decode("AAAAAF2JT1MAHfdbtyOvVQ==").unwrap();
        let header = cenc_header(&kid).unwrap();
        let mut want = vec![0x08, 0x01, 0x12, 0x10];
        want.extend_from_slice(&kid);
        want.extend_from_slice(&[0x1a, 0x00, 0x22, 0x00, 0x32, 0x00]);
        assert_eq!(header, want);

        let mut pssh = (32 + header.len() as u32).to_be_bytes().to_vec();
        pssh.extend_from_slice(b"pssh\0\0\0\0");
        pssh.extend_from_slice(&SYSTEM_ID);
        pssh.extend_from_slice(&(header.len() as u32).to_be_bytes());
        pssh.extend_from_slice(&header);
        assert_eq!(cenc_header(&pssh).unwrap(), header);
    }

    /// Plays the license server: checks the request signature, wraps a content
    /// key the way Widevine servers do and checks that the CDM recovers it.
    #[test]
    fn license_round_trip() {
        let mut cdm = Cdm::new(Device::default_device().unwrap());
        let mut f = counter_rng();
        let mut rng = Entropy(&mut f);
        let session = cdm.open(&mut rng);
        assert_eq!(&session[16..], "0100000000000000");
        let header = cenc_header_for_kid(&[1; 16]);
        let challenge = cdm.license_challenge(&session, &header, 1_700_000_000, &mut rng).unwrap();

        let signed = proto::fields(&challenge).unwrap();
        assert_eq!(proto::last_varint(&signed, 1), Some(MESSAGE_TYPE_LICENSE_REQUEST));
        let msg = proto::last_bytes(&signed, 2).unwrap();
        let public = RsaPublicKey::from(&cdm.device.key);
        assert_eq!(public.size(), 256);
        public.verify(Pss::new::<Sha1>(), &Sha1::digest(msg), proto::last_bytes(&signed, 3).unwrap()).unwrap();
        let fields = proto::fields(msg).unwrap();
        assert_eq!(proto::last_bytes(&fields, 1).unwrap(), &cdm.device.client_id[..]);
        assert_eq!(proto::last_varint(&fields, 4), Some(1_700_000_000));
        let content = proto::fields(proto::last_bytes(&fields, 2).unwrap()).unwrap();
        let cenc = proto::fields(proto::last_bytes(&content, 1).unwrap()).unwrap();
        assert_eq!(proto::last_bytes(&cenc, 1).unwrap(), &header[..]);
        assert_eq!(proto::last_bytes(&cenc, 3).unwrap(), session.as_bytes());

        let session_key = [2u8; 16];
        let content_key = [3u8; 16];
        let iv = [4u8; 16];
        let wrapping = Aes::new(&derive_encryption_key(&session_key, msg));
        let mut wrapped = [content_key.to_vec(), vec![16; 16]].concat();
        wrapping.cbc_encrypt(&mut wrapped, &iv);
        let container = |kind: u64, key: &[u8]| {
            let mut c = Vec::new();
            proto::bytes(&mut c, 1, b"kid");
            proto::bytes(&mut c, 2, &iv);
            proto::bytes(&mut c, 3, key);
            proto::uint(&mut c, 4, kind);
            c
        };
        let mut license = Vec::new();
        proto::bytes(&mut license, 3, &container(1, &wrapped)); // a SIGNING key is skipped
        proto::bytes(&mut license, 3, &container(KEY_TYPE_CONTENT, &wrapped));
        proto::uint(&mut license, 4, 1);
        let encrypted_session_key = public.encrypt(&mut rng, Oaep::new::<Sha1>(), &session_key).unwrap();
        let mut response = Vec::new();
        proto::uint(&mut response, 1, 2);
        proto::bytes(&mut response, 2, &license);
        proto::bytes(&mut response, 4, &encrypted_session_key);

        assert_eq!(cdm.parse_license(&session, &response).unwrap(), vec![(b"kid".to_vec(), content_key)]);
        cdm.close(&session);
        assert!(cdm.parse_license(&session, &response).is_err());
    }

    #[test]
    fn rejects_bad_padding() {
        assert_eq!(pkcs7_unpad(&[b'a', b'b', 2, 2]).unwrap(), b"ab");
        for bad in [&[][..], &[0], &[17], &[1, 2, 2, 3]] {
            assert!(pkcs7_unpad(bad).is_err());
        }
    }
}
