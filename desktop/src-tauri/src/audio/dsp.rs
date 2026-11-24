use crate::common::{b,n,Result};
use serde_json::Value;
use std::f64::consts::{FRAC_PI_2,PI};
pub fn fade_gains(progress:f64)->(f64,f64){let angle=progress.clamp(0.0,1.0)*FRAC_PI_2;(angle.cos(),angle.sin())}
#[derive(Clone,Default)]
struct Filter{b0:f64,b1:f64,b2:f64,a1:f64,a2:f64,z1:f64,z2:f64}
impl Filter {
    fn process(&mut self,x:f64)->f64{let y=self.b0*x+self.z1;self.z1=self.b1*x-self.a1*y+self.z2;self.z2=self.b2*x-self.a2*y;y}
    fn peaking(rate:u32,center:f64,gain:f64)->Self{
        if center>=rate as f64/2.0||gain.abs()<0.00001{return Self{b0:1.0,..Default::default()}}
        let a=10f64.powf(gain/40.0);let w=2.0*PI*center/rate as f64;let alpha=w.sin()/(2.0*1.4);let a0=1.0+alpha/a;
        Self{b0:(1.0+alpha*a)/a0,b1:-2.0*w.cos()/a0,b2:(1.0-alpha*a)/a0,a1:-2.0*w.cos()/a0,a2:(1.0-alpha/a)/a0,..Default::default()}
    }
}
pub struct Equalizer{enabled:bool,filters:Vec<Vec<Filter>>,preamp:f64}
impl Default for Equalizer{fn default()->Self{Self{enabled:false,filters:Vec::new(),preamp:1.0}}}
impl Equalizer{
    pub fn configure(&mut self,value:&Value,rate:u32,channels:usize)->Result<()> {
        let gains=value["gains"].as_array().ok_or("EQ cần 10 dải tần.")?;
        if gains.len()!=10||gains.iter().any(|x|x.as_f64().is_none_or(|g|!g.is_finite()||!(-12.0..=12.0).contains(&g)))|| !n(value,"preampDb").is_finite()||!(-24.0..=0.0).contains(&n(value,"preampDb")){return Err("Thông số EQ không hợp lệ.".into())}
        self.enabled=b(value,"enabled");
        let centers=[31.0,62.0,125.0,250.0,500.0,1000.0,2000.0,4000.0,8000.0,16000.0];
        let chain=centers.iter().zip(gains).map(|(f,g)|Filter::peaking(rate,*f,g.as_f64().unwrap())).collect::<Vec<_>>();
        self.filters=(0..channels).map(|_|chain.clone()).collect();
        // Conservative sum of positive gains gives guaranteed transfer-function headroom.
        let headroom=if b(value,"autoHeadroom"){gains.iter().map(|v|v.as_f64().unwrap().max(0.0)).sum::<f64>()}else{0.0};
        self.preamp=10f64.powf((n(value,"preampDb")-headroom)/20.0);Ok(())
    }
    pub fn process(&mut self,frame:&mut [f64]){if !self.enabled{return} for (channel,x) in frame.iter_mut().enumerate(){let mut y=*x;for filter in &mut self.filters[channel]{y=filter.process(y)}*x=y*self.preamp;}}
}
#[cfg(test)] mod tests{
    use super::*;
    #[test]fn equal_power_has_unity_sum_of_squared_gains(){for i in 0..100{let(a,b)=fade_gains(i as f64/99.0);assert!((a*a+b*b-1.0).abs()<1e-12)}assert_eq!(fade_gains(0.0),(1.0,0.0));assert!((fade_gains(1.0).1-1.0).abs()<1e-12)}
    #[test]fn neutral_biquad_keeps_samples(){let mut f=Filter::peaking(48000,1000.0,0.0);for x in [0.0,0.5,-0.25,1.0]{assert_eq!(f.process(x),x)}}
}
