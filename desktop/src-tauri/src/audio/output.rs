//! A real WASAPI client; exclusive never asks Windows to convert sample formats.
use crate::common::{err, Result};

#[cfg(windows)]
use wasapi::{AudioClient, AudioRenderClient, DeviceEnumerator, Direction, Handle, SampleType, StreamMode, WaveFormat};

pub struct Output {
    #[cfg(windows)] client: AudioClient,
    #[cfg(windows)] renderer: AudioRenderClient,
    #[cfg(windows)] event: Handle,
    pub rate: u32,
    pub channels: usize,
    pub valid_bits: u32,
    pub container_bits: u32,
    pub exclusive: bool,
    pub integer: bool,
    pub started: bool,
    timeouts: usize,
}

pub fn initialize_thread() -> Result<()> {
    #[cfg(windows)] { wasapi::initialize_mta().ok().map_err(err)?; }
    Ok(())
}
impl Output {
    #[cfg(windows)]
    pub fn open(rate: u32, channels: usize, bits: u32, exclusive: bool) -> Result<Self> {
        let enumerator = DeviceEnumerator::new().map_err(err)?;
        let device = enumerator.get_default_device(&Direction::Render).map_err(err)?;
        let mut client = device.get_iaudioclient().map_err(err)?;
        let format = if exclusive {
            if !matches!(bits, 8|16|20|24|32) { return Err(format!("Exclusive không hỗ trợ PCM {bits} bit của file này.")); }
            let container = if bits <= 16 {16} else if bits <= 24 {24} else {32};
            let requested = WaveFormat::new(container, bits as usize, &SampleType::Int, rate as usize, channels, None);
            let accepted = client.is_supported_exclusive_with_quirks(&requested).map_err(err)?;
            if accepted.get_samplespersec() != rate || accepted.get_nchannels() as usize != channels || accepted.get_validbitspersample() as u32 != bits || accepted.get_subformat().map_err(err)? != SampleType::Int {
                return Err("DAC không chấp nhận sample rate, kênh và độ sâu bit nguyên bản.".into());
            }
            accepted
        } else {
            let mix = client.get_mixformat().map_err(err)?;
            // Use the endpoint mixer rate and channel count. Software resampling is explicit.
            WaveFormat::new(32,32,&SampleType::Float,mix.get_samplespersec() as usize,mix.get_nchannels() as usize,Some(mix.get_dwchannelmask()))
        };
        let (default_period, minimum) = client.get_device_period().map_err(err)?;
        let mode = if exclusive {
            let period = client.calculate_aligned_period_near(default_period.max(minimum),Some(128),&format).map_err(err)?;
            StreamMode::EventsExclusive { period_hns: period }
        } else { StreamMode::EventsShared { autoconvert: false, buffer_duration_hns: default_period.max(100000) } };
        if let Err(initial) = client.initialize_client(&format,&Direction::Render,&mode) {
            // Exclusive endpoints may require the exact alignment returned after Initialize.
            if exclusive {
                let frames = client.get_buffer_size().map_err(|_|err(&initial))?;
                let period = wasapi::calculate_period_100ns(frames as i64,format.get_samplespersec() as i64);
                client = device.get_iaudioclient().map_err(err)?;
                client.initialize_client(&format,&Direction::Render,&StreamMode::EventsExclusive {period_hns:period}).map_err(err)?;
            } else { return Err(err(initial)); }
        }
        let event = client.set_get_eventhandle().map_err(err)?;
        let renderer = client.get_audiorenderclient().map_err(err)?;
        Ok(Self { rate:format.get_samplespersec(), channels:format.get_nchannels() as usize, valid_bits:format.get_validbitspersample() as u32, container_bits:format.get_bitspersample() as u32, integer:format.get_subformat().map_err(err)?==SampleType::Int, exclusive, client, renderer, event, started:false,timeouts:0 })
    }
    #[cfg(not(windows))]
    pub fn open(_:u32,_:usize,_:u32,_:bool)->Result<Self>{Err("Engine WASAPI yêu cầu Windows.".into())}
    pub fn available(&mut self) -> Result<usize> {
        #[cfg(windows)] {
            if self.started && self.event.wait_for_event(30).is_err() {
                self.timeouts += 1;
                if self.timeouts > 100 { return Err("Thiết bị WASAPI ngừng phản hồi.".into()); }
                return Ok(0);
            }
            self.timeouts=0;
            return self.client.get_available_space_in_frames().map(|n|n as usize).map_err(err);
        }
        #[cfg(not(windows))] { Ok(0) }
    }
    pub fn write(&mut self, frames:usize, data:&[u8]) -> Result<()> {
        #[cfg(windows)] {
            self.renderer.write_to_device(frames,data,None).map_err(err)?;
            if !self.started { self.client.start_stream().map_err(err)?;self.started=true; }
        }
        Ok(())
    }
    pub fn pause(&mut self)->Result<()> {
        #[cfg(windows)] { if self.started { self.client.stop_stream().map_err(err)?; } }
        self.started=false; Ok(())
    }
    pub fn resume(&mut self)->Result<()> {
        // Stop retains buffered frames. Restart before waiting for more free space;
        // otherwise a full paused Shared buffer can never become writable again.
        #[cfg(windows)] { if !self.started {self.client.start_stream().map_err(err)?;self.started=true;} }
        Ok(())
    }
    pub fn drain(&mut self)->Result<()> {
        #[cfg(windows)] {
            if self.started {
                if self.exclusive {self.event.wait_for_event(200).map_err(err)?;}
                else {
                    let deadline=std::time::Instant::now()+std::time::Duration::from_millis(500);
                    while self.client.get_current_padding().map_err(err)?>0 {
                        if std::time::Instant::now()>=deadline{return Err("Thiết bị không phát hết buffer cuối.".into())}
                        let _=self.event.wait_for_event(30);
                    }
                }
            }
        }
        Ok(())
    }
    pub fn append_sample(&self,sample:f64,bytes:&mut Vec<u8>){
        if !self.integer { bytes.extend_from_slice(&(sample as f32).to_le_bytes()); }
        else { encode_integer(sample,self.valid_bits,self.container_bits,bytes); }
    }
}
impl Drop for Output {
    fn drop(&mut self) { let _=self.pause(); }
}

/// Symphonia f64 exactly represents every 32-bit integer normalized by a power of two.
/// WAVEFORMATEXTENSIBLE valid bits are left aligned in the container.
pub fn encode_integer(sample:f64,valid:u32,container:u32,bytes:&mut Vec<u8>){
    let scale = (1u64 << (valid-1)) as f64;
    let minimum = -(1i64 << (valid-1));
    let maximum = (1i64 << (valid-1))-1;
    let pcm = ((sample*scale).round() as i64).clamp(minimum,maximum) << (container-valid);
    bytes.extend_from_slice(&pcm.to_le_bytes()[..(container/8) as usize]);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn exclusive_pcm_preserves_signed_16_24_and_32_bit_values(){
        for bits in [16u32,24,32] {
            let scale=(1u64 << (bits-1)) as f64;
            for value in [-(1i64 << (bits-1)),-1,0,1,(1i64 << (bits-1))-1] {
                let mut bytes=Vec::new();encode_integer(value as f64/scale,bits,bits,&mut bytes);
                assert_eq!(bytes,&value.to_le_bytes()[..(bits/8) as usize]);
            }
        }
        let mut bytes=Vec::new();encode_integer(1.0/8388608.0,24,32,&mut bytes);assert_eq!(bytes,vec![0,1,0,0]);
    }
}
