use image::{
    GrayImage, Luma, RgbImage,
    imageops::{self, FilterType},
};
use ort::{session::Session, value::Tensor};
use std::path::Path;

pub struct Ocr {
    det: Session,
    cls: Session,
    rec: Session,
    keys: Vec<String>,
}
fn infer(
    session: &mut Session,
    image: &RgbImage,
    w: u32,
    h: u32,
    det: bool,
) -> Result<(Vec<usize>, Vec<f32>), String> {
    let resized_width = if !det && w == 192 {
        ((h as f32 * image.width() as f32 / image.height() as f32).ceil() as u32).clamp(1, w)
    } else {
        w
    };
    let resized = imageops::resize(image, resized_width, h, FilterType::Triangle);
    let mut input = vec![0f32; (3 * w * h) as usize];
    for (x, y, p) in resized.enumerate_pixels() {
        for c in 0..3 {
            let v = p[2 - c] as f32 / 255.;
            input[c * (w * h) as usize + (y * w + x) as usize] = if det {
                (v - [0.485, 0.456, 0.406][c]) / [0.229, 0.224, 0.225][c]
            } else {
                (v - 0.5) / 0.5
            };
        }
    }
    let tensor = Tensor::from_array(([1usize, 3, h as usize, w as usize], input))
        .map_err(|e| e.to_string())?;
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|e| e.to_string())?;
    let (shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    Ok((shape.iter().map(|v| *v as usize).collect(), data.to_vec()))
}
fn ctc(data: &[f32], classes: usize, keys: &[String]) -> String {
    let mut text = String::new();
    let mut previous = 0;
    for step in data.chunks_exact(classes) {
        let index = step
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap()
            .0;
        if index != 0 && index != previous {
            if let Some(key) = keys.get(index) {
                text.push_str(key);
            }
        }
        previous = index;
    }
    text
}
impl Ocr {
    pub fn load(dir: &Path) -> Result<Self, String> {
        let load = |name| {
            Session::builder()
                .and_then(|b| b.with_intra_threads(2))
                .and_then(|b| b.commit_from_file(dir.join(name)))
                .map_err(|e| e.to_string())
        };
        let mut keys = vec![String::new()];
        keys.extend(
            std::fs::read_to_string(dir.join("keys.txt"))
                .map_err(|e| e.to_string())?
                .lines()
                .map(str::to_owned),
        );
        keys.push(" ".into());
        Ok(Self {
            det: load("ch_PP-OCRv4_det_infer.onnx")?,
            cls: load("cls.onnx")?,
            rec: load("ch_PP-OCRv4_rec_infer.onnx")?,
            keys,
        })
    }
    pub fn recognize(&mut self, image: &RgbImage) -> Result<String, String> {
        self.recognize_with_size(image, 960.)
    }

    pub fn recognize_with_size(
        &mut self,
        image: &RgbImage,
        max_side: f32,
    ) -> Result<String, String> {
        let scale = (max_side / image.width().max(image.height()) as f32).min(1.);
        let w = ((image.width() as f32 * scale / 32.).round() as u32 * 32).max(32);
        let h = ((image.height() as f32 * scale / 32.).round() as u32 * 32).max(32);
        let (shape, prob) = infer(&mut self.det, image, w, h, true)?;
        let mh = shape[shape.len() - 2] as u32;
        let mw = shape[shape.len() - 1] as u32;
        let mask = GrayImage::from_fn(mw, mh, |x, y| {
            Luma([if prob[(y * mw + x) as usize] > 0.3 {
                255
            } else {
                0
            }])
        });
        let contours = imageproc::contours::find_contours::<i32>(&mask);
        let mut boxes = Vec::new();
        for c in contours
            .into_iter()
            .filter(|c| c.border_type == imageproc::contours::BorderType::Outer)
            .take(1000)
        {
            let minx = c.points.iter().map(|p| p.x).min().unwrap_or(0).max(0) as u32;
            let miny = c.points.iter().map(|p| p.y).min().unwrap_or(0).max(0) as u32;
            let maxx = c.points.iter().map(|p| p.x).max().unwrap_or(0).max(0) as u32;
            let maxy = c.points.iter().map(|p| p.y).max().unwrap_or(0).max(0) as u32;
            if maxx <= minx + 2 || maxy <= miny + 2 {
                continue;
            }
            let mut score = 0.;
            let mut count = 0.;
            for y in miny..=maxy {
                for x in minx..=maxx {
                    score += prob[(y * mw + x) as usize];
                    count += 1.;
                }
            }
            if score / count < 0.5 {
                continue;
            }
            // Fit an oriented DBNet box and expand by area * unclip_ratio / perimeter.
            let corners = imageproc::geometry::min_area_rect(&c.points);
            let mut points = corners.map(|p| (p.x as f32, p.y as f32));
            points.sort_by(|a, b| a.1.total_cmp(&b.1));
            if points[0].0 > points[1].0 {
                points.swap(0, 1);
            }
            if points[2].0 < points[3].0 {
                points.swap(2, 3);
            }
            let distance =
                |a: (f32, f32), b: (f32, f32)| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
            let bw = distance(points[0], points[1]);
            let bh = distance(points[1], points[2]);
            if bw < 3. || bh < 3. {
                continue;
            }
            let pad = bw * bh * 1.5 / (2. * (bw + bh));
            let center = (
                points.iter().map(|p| p.0).sum::<f32>() / 4.,
                points.iter().map(|p| p.1).sum::<f32>() / 4.,
            );
            let ux = (
                (points[1].0 - points[0].0) / bw,
                (points[1].1 - points[0].1) / bw,
            );
            let uy = (
                (points[3].0 - points[0].0) / bh,
                (points[3].1 - points[0].1) / bh,
            );
            for (i, p) in points.iter_mut().enumerate() {
                let sx = if i == 0 || i == 3 { -1. } else { 1. };
                let sy = if i < 2 { -1. } else { 1. };
                p.0 = ((center.0 + sx * (bw / 2. + pad) * ux.0 + sy * (bh / 2. + pad) * uy.0)
                    * image.width() as f32
                    / mw as f32)
                    .clamp(0., (image.width() - 1) as f32);
                p.1 = ((center.1 + sx * (bw / 2. + pad) * ux.1 + sy * (bh / 2. + pad) * uy.1)
                    * image.height() as f32
                    / mh as f32)
                    .clamp(0., (image.height() - 1) as f32);
            }
            boxes.push(points);
        }
        boxes.sort_by_key(|b| ((b[0].1 as u32) / 12, b[0].0 as u32));
        let mut lines = Vec::new();
        for points in boxes {
            use imageproc::geometric_transformations::{Interpolation, Projection, warp_into};
            let distance =
                |a: (f32, f32), b: (f32, f32)| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
            let w = distance(points[0], points[1]).max(1.).round() as u32;
            let h = distance(points[0], points[3]).max(1.).round() as u32;
            let Some(projection) = Projection::from_control_points(
                points,
                [
                    (0., 0.),
                    ((w - 1) as f32, 0.),
                    ((w - 1) as f32, (h - 1) as f32),
                    (0., (h - 1) as f32),
                ],
            ) else {
                continue;
            };
            let mut crop = RgbImage::new(w, h);
            warp_into(
                image,
                &projection,
                Interpolation::Bilinear,
                image::Rgb([255, 255, 255]),
                &mut crop,
            );
            if h as f32 / w as f32 >= 1.5 {
                crop = imageops::rotate270(&crop);
            }
            let (_, direction) = infer(&mut self.cls, &crop, 192, 48, false)?;
            if direction.len() == 2 && direction[1] > 0.9 {
                crop = imageops::rotate180(&crop);
            }
            let rw = (48. * crop.width() as f32 / crop.height() as f32)
                .ceil()
                .clamp(16., 4096.) as u32;
            let (shape, data) = infer(&mut self.rec, &crop, rw, 48, false)?;
            let classes = *shape.last().ok_or("Invalid recognition output")?;
            if classes != self.keys.len() {
                return Err(format!(
                    "OCR dictionary mismatch: {classes} vs {}",
                    self.keys.len()
                ));
            }
            let text = ctc(&data, classes, &self.keys);
            if !text.is_empty() {
                lines.push(text);
            }
        }
        Ok(lines.join("\n"))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_models_recognize_text_and_blank() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut ocr = Ocr::load(&root.join("resources/ocr")).unwrap();
        let image = image::open(root.join("../tests/fixtures/ocr.png"))
            .unwrap()
            .to_rgb8();
        let result = ocr.recognize(&image).unwrap();
        println!("OCR: {result}");
        assert!(result.contains("中文测试"), "{result}");
        assert!(result.contains("12345"), "{result}");
        let document = imageops::resize(
            &image,
            1920,
            image.height() * 1920 / image.width(),
            imageops::FilterType::Lanczos3,
        );
        let result = ocr.recognize_with_size(&document, 1920.).unwrap();
        assert!(result.contains("中文测试"), "{result}");
        assert!(result.contains("12345"), "{result}");
        assert!(
            ocr.recognize(&RgbImage::from_pixel(320, 160, image::Rgb([255, 255, 255])))
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn ctc_blank_and_repeats() {
        let keys = vec!["".into(), "中".into(), "文".into()];
        assert_eq!(
            ctc(
                &[0., 1., 0., 0., 1., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1.],
                3,
                &keys
            ),
            "中中文"
        );
    }
}
