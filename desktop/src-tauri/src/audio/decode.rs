//! Bounded decoder queues. Neither file I/O nor an entire album is retained in memory.
use crate::common::{err, Result};
use crossbeam_channel::{bounded, Receiver};
use std::{collections::VecDeque, fs::File, path::Path, time::Duration};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{CodecParameters, Decoder, DecoderOptions, CODEC_TYPE_NULL},
    errors::Error,
    formats::{FormatOptions, FormatReader, SeekMode, SeekTo},
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
    units::Time,
};

pub struct Reader {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    params: CodecParameters,
    track_id: u32,
    skip_until: f64,
    pending: Option<Vec<f64>>,
    pub rate: u32,
    pub channels: usize,
    pub bits: u32,
}
impl Reader {
    pub fn is_alac(&self)->bool {self.params.codec==symphonia::core::codecs::CODEC_TYPE_ALAC}
    pub fn is_flac(&self)->bool {self.params.codec==symphonia::core::codecs::CODEC_TYPE_FLAC}
    pub fn duration_hint(&self)->Option<f64> {
        self.params.n_frames.map(|frames|self.params.time_base.map(|base|{
            let time=base.calc_time(frames);time.seconds as f64+time.frac
        }).unwrap_or(frames as f64/self.rate as f64)).filter(|seconds|seconds.is_finite()&&*seconds>0.)
    }
    pub fn open(path: &Path, position: f64) -> Result<Self> {
        let file = File::open(path).map_err(err)?;
        let stream = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) { hint.with_extension(ext); }
        let mut format = symphonia::default::get_probe()
            .format(&hint, stream, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default())
            .map_err(err)?.format;
        let track = format.default_track().or_else(|| format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL))
            .ok_or("Không tìm thấy luồng âm thanh.")?;
        let params = track.codec_params.clone();
        let track_id = track.id;
        let mut decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).map_err(err)?;
        // Some MP4/ALAC demuxers expose the channel layout only on the first
        // decoded packet. Read it once and retain its samples for normal playback.
        let (rate,channels,first_samples)=loop {
            let packet=format.next_packet().map_err(err)?;
            if packet.track_id()!=track_id {continue}
            let decoded=decoder.decode(&packet).map_err(err)?;
            let spec=*decoded.spec();
            let mut buffer=SampleBuffer::<f64>::new(decoded.capacity() as u64,spec);
            buffer.copy_interleaved_ref(decoded);
            break (spec.rate,spec.channels.count(),buffer.samples().to_vec());
        };
        let bits = decoder.codec_params().bits_per_sample.or(params.bits_per_sample).unwrap_or(24);
        if !(8000..=768000).contains(&rate) || channels == 0 || channels > 8 || bits == 0 || bits > 64 {
            return Err("Định dạng âm thanh vượt giới hạn 8 kênh / 768 kHz.".into());
        }
        if position > 0.0 {
            format.seek(SeekMode::Accurate, SeekTo::Time { time: Time::from(position), track_id: Some(track_id) }).map_err(err)?;
            decoder.reset();
        }
        Ok(Self { format, decoder, params, track_id, skip_until: position, pending:if position>0.0{None}else{Some(first_samples)}, rate, channels, bits })
    }
    pub fn chunk(&mut self) -> Result<Option<Vec<f64>>> {
        if let Some(samples)=self.pending.take(){return Ok(Some(samples))}
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(e) => return Err(err(e)),
            };
            if packet.track_id() != self.track_id { continue; }
            let packet_start = self.params.time_base.map(|tb| {
                let t = tb.calc_time(packet.ts()); t.seconds as f64 + t.frac
            }).unwrap_or(packet.ts() as f64 / self.rate as f64);
            let decoded = self.decoder.decode(&packet).map_err(err)?;
            if decoded.spec().rate != self.rate || decoded.spec().channels.count() != self.channels {
                return Err("Luồng đổi định dạng giữa bài; hãy mở lại bài hát.".into());
            }
            if decoded.frames() > 262144 { return Err("Gói âm thanh quá lớn.".into()); }
            let mut buffer = SampleBuffer::<f64>::new(decoded.capacity() as u64, *decoded.spec());
            buffer.copy_interleaved_ref(decoded);
            let skip = ((self.skip_until - packet_start).max(0.0) * self.rate as f64).round() as usize;
            let samples = buffer.samples();
            let offset = skip.saturating_mul(self.channels).min(samples.len());
            if offset == samples.len() { continue; }
            self.skip_until = 0.0;
            return Ok(Some(samples[offset..].to_vec()));
        }
    }
}

pub struct Deck {
    pub id: String,
    pub rate: u32,
    pub channels: usize,
    pub bits: u32,
    pub duration: f64,
    pub position: f64,
    pub end: f64,
    rx: Receiver<Result<Option<Vec<f64>>>>,
    queued: VecDeque<f64>,
    current: Option<Vec<f64>>,
    following: Option<Vec<f64>>,
    phase: f64,
    eof: bool,
}
impl Deck {
    pub fn open(id: String, path: &Path, duration: f64, position: f64, end: f64) -> Result<Self> {
        let mut reader = Reader::open(path, position)?;
        let (rate, channels, bits) = (reader.rate, reader.channels, reader.bits);
        let (tx, rx) = bounded(6);
        std::thread::Builder::new().name("luma-decoder".into()).spawn(move || {
            loop {
                let chunk = reader.chunk();
                let complete = !matches!(&chunk, Ok(Some(_)));
                if tx.send(chunk).is_err() || complete { break; }
            }
        }).map_err(err)?;
        Ok(Self { id, rate, channels, bits, duration, position, end: end.max(position), rx, queued: VecDeque::new(), current: None, following: None, phase: 0.0, eof: false })
    }
    fn source_frame(&mut self) -> Result<Option<Vec<f64>>> {
        while self.queued.len() < self.channels && !self.eof {
            match self.rx.recv_timeout(Duration::from_secs(2)).map_err(|_| "Bộ giải mã không phản hồi.".to_string())?? {
                Some(chunk) => self.queued.extend(chunk),
                None => self.eof = true,
            }
        }
        if self.queued.len() < self.channels { return Ok(None); }
        Ok(Some((0..self.channels).map(|_| self.queued.pop_front().unwrap_or(0.0)).collect()))
    }
    pub fn frame(&mut self, target_rate: u32, target_channels: usize) -> Result<Option<Vec<f64>>> {
        if self.position >= self.end { return Ok(None); }
        if self.current.is_none() { self.current = self.source_frame()?; }
        let Some(current) = self.current.as_ref() else { return Ok(None); };
        // Identical rates take an exact copy path: no interpolation and no precision loss.
        if self.rate == target_rate {
            let output = map_channels(current, target_channels);
            self.current = self.source_frame()?;
            self.position += 1.0 / target_rate as f64;
            return Ok(Some(output));
        }
        if self.following.is_none() { self.following = self.source_frame()?; }
        let current = self.current.as_ref().unwrap();
        let next = self.following.as_ref().unwrap_or(current);
        let mixed = current.iter().zip(next).map(|(a,b)| a + (b-a)*self.phase).collect::<Vec<_>>();
        let output = map_channels(&mixed, target_channels);
        self.phase += self.rate as f64 / target_rate as f64;
        while self.phase >= 1.0 {
            self.phase -= 1.0;
            self.current = self.following.take();
            self.following = self.source_frame()?;
            if self.current.is_none() { break; }
        }
        self.position += 1.0 / target_rate as f64;
        Ok(Some(output))
    }
}
fn map_channels(frame: &[f64], channels: usize) -> Vec<f64> {
    if frame.len() == channels { return frame.to_vec(); }
    if channels == 1 { return vec![frame.iter().sum::<f64>() / frame.len() as f64]; }
    if frame.len() == 1 { return vec![frame[0]; channels]; }
    // Preserve front left/right, distribute the remaining channels at -6 dB.
    let mut out = vec![0.0; channels];
    for (i, sample) in frame.iter().enumerate() { out[i % channels] += sample * if i < channels {1.0} else {0.5}; }
    out
}

/// Energy cue analysis examines only the first/last 8 seconds with 20 ms windows.
/// It trims silence, not beats, and never silently shortens more than eight seconds.
pub fn cue_bounds(path: &Path, duration: f64) -> Result<(f64, f64)> {
    if duration <= 0.1 { return Ok((0.0, duration)); }
    let head = energy_windows(path, 0.0, duration.min(8.0))?;
    let tail_start = (duration - 8.0).max(0.0);
    let tail = energy_windows(path, tail_start, duration - tail_start)?;
    let peak = head.iter().chain(&tail).copied().fold(0.0_f64, f64::max);
    let threshold = (peak * 0.08).max(0.0001); // relative -22 dB, absolute -80 dB RMS floor
    let start = head.iter().position(|rms| *rms > threshold).map(|i| i as f64 * 0.02).unwrap_or(0.0);
    let end = tail.iter().rposition(|rms| *rms > threshold).map(|i| tail_start + (i + 1) as f64 * 0.02).unwrap_or(duration).min(duration);
    if end > start + 0.1 { Ok((start, end)) } else { Ok((0.0, duration)) }
}
fn energy_windows(path: &Path, start: f64, seconds: f64) -> Result<Vec<f64>> {
    let mut reader = Reader::open(path, start)?;
    let window = ((reader.rate as f64 * 0.02).round() as usize * reader.channels).max(1);
    let limit = (seconds * reader.rate as f64) as usize * reader.channels;
    let mut count = 0usize; let mut sum = 0.0; let mut used = 0usize; let mut result = Vec::new();
    while used < limit {
        let Some(chunk) = reader.chunk()? else { break; };
        for x in chunk.into_iter().take(limit-used) {
            sum += x*x; count += 1; used += 1;
            if count == window { result.push((sum/count as f64).sqrt()); sum=0.0; count=0; }
        }
    }
    if count > 0 { result.push((sum/count as f64).sqrt()); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn channel_mapping_keeps_stereo_and_upmixes_mono() {
        assert_eq!(map_channels(&[0.25,-0.5],2), vec![0.25,-0.5]);
        assert_eq!(map_channels(&[0.125],2), vec![0.125,0.125]);
        assert_eq!(map_channels(&[0.5,-0.5],1),vec![0.0]);
    }
}
