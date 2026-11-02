//! User initiated, coarse location and fixed Open-Meteo endpoints. Never log location data.
use crate::{
    diagnostics::now,
    model_config::{chat_only, crypt},
};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{Manager, WebviewWindow};

pub struct Locations {
    path: PathBuf,
    candidates: Mutex<HashMap<String, Value>>,
}
impl Locations {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join("location-v1.bin"),
            candidates: Mutex::new(HashMap::new()),
        }
    }
    pub fn selected(&self) -> Result<Value, &'static str> {
        if !self.path.exists() {
            return Ok(Value::Null);
        }
        let data = crypt(&fs::read(&self.path).map_err(|_| "storage")?, false)
            .map_err(|_| "location_config")?;
        let v: Value = serde_json::from_slice(&data).map_err(|_| "location_config")?;
        if !v.is_null() {
            coordinates(&v)?;
        }
        Ok(v)
    }
    fn remember(&self, items: &[Value]) -> Result<(), &'static str> {
        let mut c = self.candidates.lock().map_err(|_| "config")?;
        c.clear();
        for v in items {
            c.insert(v["id"].as_str().ok_or("response")?.into(), v.clone());
        }
        Ok(())
    }
    fn save(&self, id: &str) -> Result<Value, &'static str> {
        let v = if id.is_empty() {
            Value::Null
        } else {
            self.candidates
                .lock()
                .map_err(|_| "config")?
                .get(id)
                .cloned()
                .ok_or("location_missing")?
        };
        fs::create_dir_all(self.path.parent().ok_or("storage")?).map_err(|_| "storage")?;
        let bytes = crypt(&serde_json::to_vec(&v).map_err(|_| "config")?, true)?;
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, bytes).map_err(|_| "storage")?;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };
        let from: Vec<u16> = tmp
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let to: Vec<u16> = self
            .path
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|_| "storage")?;
        }
        Ok(v)
    }
}
fn coordinates(v: &Value) -> Result<(f64, f64), &'static str> {
    let lat = v["latitude"].as_f64().ok_or("location_missing")?;
    let lon = v["longitude"].as_f64().ok_or("location_missing")?;
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90. || lon.abs() > 180. {
        return Err("location_missing");
    }
    Ok((lat, lon))
}
fn coarse(x: f64) -> f64 {
    (x * 100.).round() / 100.
}
async fn get(
    url: &str,
    params: &[(&str, String)],
    deadline_ms: Option<u64>,
) -> Result<Value, &'static str> {
    let timeout = deadline_ms
        .map(crate::model_transport::remaining_time)
        .transpose()?
        .unwrap_or(Duration::from_secs(20))
        .min(Duration::from_secs(20));
    let c = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .build()
        .map_err(|_| "weather_connection")?;
    let mut url = reqwest::Url::parse(url).map_err(|_| "config")?;
    url.query_pairs_mut()
        .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
    let mut r = c.get(url).send().await.map_err(|e| {
        if e.is_timeout() {
            "weather_timeout"
        } else {
            "weather_connection"
        }
    })?;
    if !r.status().is_success() {
        return Err(if r.status().as_u16() == 429 {
            "weather_limit"
        } else {
            "weather_server"
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|_| "weather_connection")? {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err("weather_response");
        }
        bytes.extend(chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "weather_response")
}
pub async fn find_places(query: &str) -> Result<Vec<Value>, &'static str> {
    find_places_with_deadline(query, None).await
}
async fn find_places_with_deadline(
    query: &str,
    deadline_ms: Option<u64>,
) -> Result<Vec<Value>, &'static str> {
    if !(2..=100).contains(&query.trim().chars().count()) || query.chars().any(char::is_control) {
        return Err("location_query");
    }
    let raw = get(
        "https://geocoding-api.open-meteo.com/v1/search",
        &[
            ("name", query.trim().into()),
            ("language", "zh".into()),
            ("count", "10".into()),
        ],
        deadline_ms,
    )
    .await?;
    Ok(raw["results"].as_array().map(|rs|rs.iter().filter_map(|v|{
        let (lat,lon)=coordinates(v).ok()?;let name=v["name"].as_str()?;
        let labels:Vec<&str>=[v["country"].as_str(),v["admin1"].as_str(),Some(name)].into_iter().flatten().collect();
        Some(json!({"id":v["id"].as_u64()?.to_string(),"label":labels.join(" · "),"region":v["admin1"],"name":name,"latitude":coarse(lat),"longitude":coarse(lon),"origin":"city","acquiredAt":now()}))
    }).collect()).unwrap_or_default())
}
#[tauri::command]
pub fn location_get(window: WebviewWindow, app: tauri::AppHandle) -> Result<Value, &'static str> {
    chat_only(&window)?;
    app.state::<Locations>().selected()
}
#[tauri::command]
pub async fn location_search(
    window: WebviewWindow,
    app: tauri::AppHandle,
    query: String,
) -> Result<Vec<Value>, &'static str> {
    chat_only(&window)?;
    let found = find_places(&query).await?;
    app.state::<Locations>().remember(&found)?;
    Ok(found)
}
#[tauri::command]
pub fn location_save(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<Value, &'static str> {
    chat_only(&window)?;
    app.state::<Locations>().save(&id)
}
#[tauri::command]
pub async fn location_device(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Value, &'static str> {
    chat_only(&window)?;
    // Request permission on the visible UI thread, and await without blocking that thread.
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(windows::Devices::Geolocation::Geolocator::RequestAccessAsync());
    })
    .map_err(|_| "location_unavailable")?;
    let op = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
        .await
        .map_err(|_| "location_unavailable")?
        .map_err(|_| "location_unavailable")?
        .map_err(|_| "location_unavailable")?;
    use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator, PositionAccuracy};
    let access = tauri::async_runtime::spawn_blocking(move || {
        let start = std::time::Instant::now();
        while op.Status().map_err(|_| "location_unavailable")?.0 == 0 {
            if start.elapsed() > Duration::from_secs(60) {
                let _ = op.Cancel();
                return Err("location_unavailable");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        op.GetResults().map_err(|_| "location_unavailable")
    })
    .await
    .map_err(|_| "location_unavailable")??;
    if access != GeolocationAccessStatus::Allowed {
        return Err("location_denied");
    }
    let v=tauri::async_runtime::spawn_blocking(move||->Result<Value,&'static str>{
    let locator=Geolocator::new().map_err(|_|"location_unavailable")?;
    locator.SetDesiredAccuracy(PositionAccuracy::Default).map_err(|_|"location_unavailable")?;
    let pos=locator.GetGeopositionAsyncWithAgeAndTimeout(windows::Foundation::TimeSpan{Duration:600_000_000},windows::Foundation::TimeSpan{Duration:200_000_000}).map_err(|_|"location_unavailable")?.get().map_err(|_|"location_unavailable")?;
    let c=pos.Coordinate().map_err(|_|"location_unavailable")?;
    let p=c.Point().and_then(|p|p.Position()).map_err(|_|"location_unavailable")?;
    let v=json!({"id":"device","label":"Windows 位置（约 1 公里网格）","latitude":coarse(p.Latitude),"longitude":coarse(p.Longitude),"origin":"windows","accuracyMeters":c.Accuracy().ok(),"acquiredAt":now()});
    coordinates(&v)?;Ok(v)
    }).await.map_err(|_|"location_unavailable")??;
    app.state::<Locations>()
        .remember(std::slice::from_ref(&v))?;
    Ok(v)
}
pub fn tool() -> Value {
    json!({"type":"function","function":{"name":"get_weather","description":"获取当前天气及未来3天预报。place为城市或区县名称，region为省/直辖市以消歧；place留空使用用户保存的位置。不要猜坐标，不需要Tavily密钥。","parameters":{"type":"object","properties":{"place":{"type":"string"},"region":{"type":"string"}},"required":["place","region"],"additionalProperties":false}}})
}
fn region_key(s: &str) -> &str {
    s.trim().trim_end_matches(['省', '市'])
}
pub fn choose_place(found: Vec<Value>, region: &str) -> Result<Value, &'static str> {
    let found: Vec<_> = found
        .into_iter()
        .filter(|v| {
            region.is_empty()
                || region_key(v["region"].as_str().unwrap_or("")) == region_key(region)
        })
        .collect();
    match found.len() {
        0 => Err("location_not_found"),
        1 => Ok(found[0].clone()),
        _ => Err("location_ambiguous"),
    }
}
pub(crate) async fn weather_with_deadline(
    args: &Value,
    selected: &Value,
    deadline_ms: Option<u64>,
) -> Result<Value, &'static str> {
    let obj = args.as_object().ok_or("tool_arguments")?;
    let place = args["place"].as_str().ok_or("tool_arguments")?.trim();
    let region = args["region"].as_str().ok_or("tool_arguments")?.trim();
    if obj.len() != 2 || place.chars().count() > 100 || region.chars().count() > 80 {
        return Err("tool_arguments");
    }
    let p = if place.is_empty() {
        selected.clone()
    } else {
        choose_place(find_places_with_deadline(place, deadline_ms).await?, region)?
    };
    let (lat, lon) = coordinates(&p)?;
    let params=[("latitude",lat.to_string()),("longitude",lon.to_string()),("current","temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation".into()),("daily","weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max".into()),("timezone","auto".into()),("forecast_days","3".into()),("timeformat","unixtime".into())];
    let raw = get(
        "https://api.open-meteo.com/v1/forecast",
        &params,
        deadline_ms,
    )
    .await?;
    let mut data = normalize_weather(&raw, &p)?;
    let mut source =
        reqwest::Url::parse("https://api.open-meteo.com/v1/forecast").map_err(|_| "config")?;
    source
        .query_pairs_mut()
        .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
    data["sourceUrl"] = json!(source.as_str());
    Ok(data)
}
pub fn normalize_weather(raw: &Value, p: &Value) -> Result<Value, &'static str> {
    let t = raw["current"]["time"].as_u64().ok_or("weather_response")?;
    if (now() / 1000).abs_diff(t) > 3 * 3600 {
        return Err("weather_stale");
    }
    if !raw["current"]["temperature_2m"].is_number()
        || raw["daily"]["time"].as_array().is_none_or(|a| a.is_empty())
    {
        return Err("weather_response");
    }
    Ok(
        json!({"location":p["label"],"retrievedAt":now(),"timezone":raw["timezone"],"utcOffsetSeconds":raw["utc_offset_seconds"],"current":raw["current"],"currentUnits":raw["current_units"],"daily":raw["daily"],"dailyUnits":raw["daily_units"],"provider":"Open-Meteo","dataType":"天气模型估算与预报，并非本地气象站实时观测","instruction":"时间为 Unix 秒；按返回时区换算。区分当前估算与未来预报；引用来源，不能冒充气象站实测。"}),
    )
}
/// Model-facing weather data is an allowlist, including nested measurements.
/// Provider responses and persisted history may contain request coordinates/URLs.
fn weather_text(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    !s.is_empty() && s.chars().count() <= 300 && !s.chars().any(char::is_control)
        && !["://", "www.", "open-meteo", "latitude", "longitude", "lat=", "lon=", "sourceurl", "\u{5317}\u{7eac}", "\u{4e1c}\u{7ecf}", "\u{7eac}\u{5ea6}", "\u{7ecf}\u{5ea6}"].iter().any(|x| lower.contains(x))
        // A place name may contain digits, but decimal coordinate text is not a name.
        && !s.as_bytes().windows(3).any(|w| w[0].is_ascii_digit() && w[1] == b'.' && w[2].is_ascii_digit())
        && !s.split_once(',').is_some_and(|(a,b)| a.trim().parse::<f64>().is_ok() && b.trim().parse::<f64>().is_ok())
}
fn measurement(key: &str, value: &Value) -> bool {
    match key {
        "time" => value.as_u64().is_some_and(|n| n <= 253_402_300_799),
        "interval" => value.as_u64().is_some_and(|n| n <= 86_400),
        _ => value.as_f64().is_some_and(f64::is_finite),
    }
}
fn weather_unit(key: &str, value: &Value) -> bool {
    let Some(unit) = value.as_str() else {
        return false;
    };
    match key {
        "time" => unit == "unixtime",
        "interval" => matches!(unit, "seconds" | "s"),
        "temperature_2m" | "apparent_temperature" | "temperature_2m_max" | "temperature_2m_min" => {
            matches!(unit, "°C" | "°F")
        }
        "relative_humidity_2m" | "precipitation_probability_max" => unit == "%",
        "weather_code" => matches!(unit, "wmo code" | "WMO code"),
        "wind_speed_10m" => matches!(unit, "km/h" | "m/s" | "mp/h" | "mph" | "kn"),
        "precipitation" => matches!(unit, "mm" | "inch"),
        _ => false,
    }
}
pub(crate) fn weather_projection(data: &Value) -> Value {
    let mut out = json!({});
    if let Some(label) = data["location"].as_str().filter(|s| weather_text(s)) {
        out["location"] = json!(label);
    }
    if let Some(time) = data["retrievedAt"].as_u64() {
        out["retrievedAt"] = json!(time);
    }
    if let Some(zone) = data["timezone"].as_str().filter(|s| {
        weather_text(s)
            && s.len() <= 80
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b))
    }) {
        out["timezone"] = json!(zone);
    }
    if let Some(offset) = data["utcOffsetSeconds"]
        .as_i64()
        .filter(|n| n.unsigned_abs() <= 86_400)
    {
        out["utcOffsetSeconds"] = json!(offset);
    }
    out["provider"] = json!("Open-Meteo");
    out["dataType"] =
        json!("Weather model estimates and forecast; not a local station observation.");
    out["instruction"] = json!("Times are Unix seconds. Distinguish current model estimates from forecasts and cite the registered source.");
    for section in ["current", "currentUnits", "daily", "dailyUnits"] {
        if let Some(obj) = data[section].as_object() {
            let mut measurements = serde_json::Map::new();
            let keys: &[&str] = if section.starts_with("current") {
                &[
                    "time",
                    "interval",
                    "temperature_2m",
                    "apparent_temperature",
                    "relative_humidity_2m",
                    "weather_code",
                    "wind_speed_10m",
                    "precipitation",
                ]
            } else {
                &[
                    "time",
                    "weather_code",
                    "temperature_2m_max",
                    "temperature_2m_min",
                    "precipitation_probability_max",
                ]
            };
            for &key in keys {
                if let Some(v) = obj.get(key) {
                    let valid = if section.ends_with("Units") {
                        weather_unit(key, v)
                    } else if section == "current" {
                        measurement(key, v)
                    } else {
                        v.as_array().is_some_and(|a| {
                            !a.is_empty()
                                && a.len() <= 366
                                && a.iter()
                                    .all(|v| (key != "time" && v.is_null()) || measurement(key, v))
                        })
                    };
                    if valid {
                        measurements.insert(key.into(), v.clone());
                    }
                }
            }
            out[section] = Value::Object(measurements);
        }
    }
    out
}
/// Only a bounded last-turn continuation: unrelated old weather must not force future searches.
pub fn weather_intent(messages: &Value) -> bool {
    let Some(m) = messages.as_array() else {
        return false;
    };
    let Some(last) = m.last() else {
        return false;
    };
    let text = last["content"].as_str().unwrap_or("");
    let is_weather = |s: &str| {
        [
            "天气",
            "气温",
            "下雨",
            "降雨",
            "weather",
            "temperature",
            "forecast",
        ]
        .iter()
        .any(|x| s.to_lowercase().contains(x))
    };
    if is_weather(text) {
        return true;
    }
    text.chars().count() <= 60
        && m.len() >= 3
        && is_weather(m[m.len() - 3]["content"].as_str().unwrap_or(""))
        && ["城市", "地区", "区县", "哪里", "哪个"]
            .iter()
            .any(|x| m[m.len() - 2]["content"].as_str().unwrap_or("").contains(x))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn weather_projection_keeps_measurements_but_never_provider_coordinates_or_urls() {
        let raw = json!({"location":"Test City", "retrievedAt":123, "latitude":1.0,"longitude":2.0,"sourceUrl":"https://api.open-meteo.com/?latitude=1.0", "current":{"temperature_2m":20,"latitude":1.0,"url":"secret"},"daily":{"time":[123],"temperature_2m_max":[22]},"currentUnits":{"temperature_2m":"°C"}});
        let projected = weather_projection(&raw);
        assert_eq!(projected["current"]["temperature_2m"], 20);
        assert_eq!(projected["daily"]["temperature_2m_max"], json!([22]));
        assert_eq!(projected["location"], "Test City");
        for forbidden in [
            "latitude",
            "longitude",
            "sourceUrl",
            "1.0",
            "2.0",
            "api.open-meteo",
            "secret",
        ] {
            assert!(!projected.to_string().contains(forbidden));
        }
    }
    #[test]
    fn weather_projection_rejects_nested_values_and_url_units_but_keeps_valid_data() {
        let private =
            json!({"latitude":1.0,"sourceUrl":"https://api.open-meteo.com/?longitude=2.0"});
        let raw = json!({"location":"Test City","timezone":"Asia/Shanghai","utcOffsetSeconds":28800,"retrievedAt":123,
            "current":{"time":123,"interval":900,"temperature_2m":20,"relative_humidity_2m":private,"precipitation":"https://provider.example/latitude=1.0"},
            "daily":{"time":[123,456],"temperature_2m_max":[21,null],"temperature_2m_min":[private],"weather_code":{"longitude":2.0}},
            "currentUnits":{"time":"unixtime","interval":"seconds","temperature_2m":"\u{b0}C","relative_humidity_2m":"https://provider.example/?latitude=1.0","precipitation":private},
            "dailyUnits":{"temperature_2m_max":"\u{b0}C","weather_code":"wmo code","temperature_2m_min":"1.0,2.0"}});
        let projected = weather_projection(&raw);
        assert_eq!(projected["current"]["temperature_2m"], 20);
        assert_eq!(projected["daily"]["temperature_2m_max"], json!([21, null]));
        assert_eq!(projected["timezone"], "Asia/Shanghai");
        assert_eq!(projected["currentUnits"]["temperature_2m"], "\u{b0}C");
        assert_eq!(projected["dailyUnits"]["weather_code"], "wmo code");
        for forbidden in [
            "latitude",
            "longitude",
            "sourceUrl",
            "1.0",
            "2.0",
            "provider.example",
            "api.open-meteo",
        ] {
            assert!(!projected.to_string().contains(forbidden), "{forbidden}");
        }
        assert!(projected["current"].get("relative_humidity_2m").is_none());
        assert!(projected["daily"].get("temperature_2m_min").is_none());
    }
    #[test]
    fn weather_projection_rejects_malformed_text_time_and_unit_types() {
        for label in [
            json!({"latitude":1.0}),
            json!("Test https://api.open-meteo.com"),
            json!("1.0,2.0"),
            json!("39,116"),
        ] {
            let projected = weather_projection(
                &json!({"location":label,"timezone":"https://provider.example","retrievedAt":{"longitude":2.0},"utcOffsetSeconds":i64::MIN,"current":{"time":-1,"interval":90000,"temperature_2m":"20"},"daily":{"time":["123"],"temperature_2m_max":[{"latitude":1.0}]},"currentUnits":{"temperature_2m":{"sourceUrl":"https://provider.example"}}}),
            );
            assert!(projected.get("location").is_none());
            assert!(projected.get("timezone").is_none());
            assert!(projected.get("retrievedAt").is_none());
            assert!(projected.get("utcOffsetSeconds").is_none());
            assert_eq!(projected["current"], json!({}));
            assert_eq!(projected["daily"], json!({}));
            assert_eq!(projected["currentUnits"], json!({}));
        }
        assert_eq!(
            weather_projection(&json!({"location":"100 Mile House"}))["location"],
            "100 Mile House"
        );
    }
    #[test]
    fn followup_city_retains_weather_intent() {
        assert!(weather_intent(
            &json!([{"content":"今天天气怎么样"},{"content":"哪个城市？"},{"content":"Test Region, Test City"}])
        ));
        assert!(!weather_intent(&json!([{"content":"你好"}])));
    }
    #[test]
    fn region_must_match_and_never_guess() {
        let v = vec![json!({"region":"Test Region市"}), json!({"region":"江苏省"})];
        assert_eq!(choose_place(v.clone(), "Test Region").unwrap()["region"], "Test Region市");
        assert_eq!(choose_place(v, ""), Err("location_ambiguous"));
    }
    #[test]
    fn rejects_stale_and_invalid_coordinates() {
        assert!(coordinates(&json!({"latitude":100,"longitude":0})).is_err());
        assert_eq!(
            normalize_weather(&json!({"current":{"time":1}}), &Value::Null),
            Err("weather_stale")
        );
    }
    #[test]
    fn saved_location_is_encrypted_restored_cleared_and_corruption_reported() {
        let root = std::env::temp_dir().join(format!(
            "linedog-location-test-{}-{}",
            std::process::id(),
            now()
        ));
        let store = Locations::new(root.clone());
        let p =
            json!({"id":"test","label":"test-private-place","latitude":1.0,"longitude":2.0});
        assert!(store.selected().unwrap().is_null());
        store.remember(std::slice::from_ref(&p)).unwrap();
        assert!(store.save("invented").is_err());
        store.save("test").unwrap();
        assert!(!String::from_utf8_lossy(&fs::read(&store.path).unwrap())
            .contains("test-private-place"));
        assert_eq!(Locations::new(root.clone()).selected().unwrap(), p);
        store.save("").unwrap();
        assert!(store.selected().unwrap().is_null());
        fs::write(&store.path, b"broken").unwrap();
        assert_eq!(store.selected(), Err("location_config"));
        fs::remove_file(&store.path).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
