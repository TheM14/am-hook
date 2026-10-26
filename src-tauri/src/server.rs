//! 服务器检查：确认目标是一个可用的 am-hook 实例，并取出页面要用到的能力标记。
//!
//! 只从公开的资源判断，不依赖具体版本号：
//! - `/` 返回单页应用外壳（引用 `/assets/` 下的资源）
//! - `/assets/host.js` 是 am-hook 生成的 `window.AM_HOOK_HOST = {...}`
//! - `/assets/decrypt.js` 提供 `AmDecrypt.openTrack`，mpv 输出靠它取流解密
//! - `/status` 是转发 wrapper-lite 的状态（`--local-wrapper-only` 时为 501，同样算 am-hook）

use std::time::Duration;

use reqwest::header::HeaderMap;
use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::state::ServerInfo;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckError {
    /// network | http | challenge | not-am-hook | incompatible | bad-url
    pub kind: String,
    pub message: String,
    pub url: String,
}

impl CheckError {
    fn new(kind: &str, message: impl Into<String>, url: &str) -> Self {
        Self { kind: kind.to_string(), message: message.into(), url: url.to_string() }
    }
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(6))
        .user_agent("am-hook-GUI")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 把用户输入的地址整理成 `http://host:port`：补协议、去掉末尾斜杠和页面路径
pub fn normalize(raw: &str) -> Result<Url, CheckError> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(CheckError::new("bad-url", "请输入服务器地址", raw));
    }
    let with_scheme = if text.contains("://") { text.to_string() } else { format!("http://{text}") };
    let mut url = Url::parse(&with_scheme)
        .map_err(|error| CheckError::new("bad-url", format!("地址格式不正确：{error}"), raw))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(CheckError::new("bad-url", "只支持 http:// 或 https:// 地址", raw));
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err(CheckError::new("bad-url", "地址里缺少主机名", raw));
    }
    // 用户可能直接粘贴了某个页面地址（如 /song/123）：只保留站点根
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn base(url: &Url) -> String {
    let mut text = url.as_str().trim_end_matches('/').to_string();
    text.push('/');
    text
}

/// 把 reqwest 的错误换成用户能看懂的一句话
fn friendly(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "请求超时：服务器没有在限定时间内响应".to_string()
    } else if error.is_connect() {
        "无法建立连接：am-hook 可能没有运行，或地址 / 端口不对".to_string()
    } else if error.is_decode() {
        "响应无法解析".to_string()
    } else {
        format!("请求失败：{error}")
    }
}

async fn get_text(
    client: &reqwest::Client,
    url: &str,
) -> Result<(reqwest::StatusCode, HeaderMap, String, String), CheckError> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| CheckError::new("network", friendly(&error), url))?;
    let status = response.status();
    let headers = response.headers().clone();
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = response
        .text()
        .await
        .map_err(|error| CheckError::new("network", friendly(&error), url))?;
    Ok((status, headers, content_type, text))
}

/// Cloudflare 的托管挑战：请求根本没到 am-hook，拿到的是一张验证页。
///
/// 挑战页可能是 403，也可能是 200；`cf-mitigated: challenge` 最可靠，正文标识作为兜底。
fn is_challenge(status: reqwest::StatusCode, headers: &HeaderMap, body: &str) -> bool {
    if headers
        .get("cf-mitigated")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("challenge"))
    {
        return true;
    }
    let body = body.to_ascii_lowercase();
    let marker = body.contains("challenges.cloudflare.com")
        || body.contains("just a moment")
        || body.contains("cf-chl-");
    marker
        && (status == reqwest::StatusCode::FORBIDDEN
            || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
            || status.is_success())
}

fn challenge_error(url: &str) -> CheckError {
    CheckError::new(
        "challenge",
        "目标站点启用了 Cloudflare 人机验证，服务器检查被拦截。如果确认这是 am-hook，可以继续打开，在页面里完成验证",
        url,
    )
}

/// 检查目标服务器；成功后返回页面要用的信息
pub async fn check(client: &reqwest::Client, raw: &str) -> Result<ServerInfo, CheckError> {
    let url = normalize(raw)?;
    let base_url = base(&url);

    let (status, headers, content_type, html) = get_text(client, &base_url).await?;
    if is_challenge(status, &headers, &html) {
        return Err(challenge_error(&base_url));
    }
    if !status.is_success() {
        return Err(CheckError::new(
            "http",
            format!("服务器返回 HTTP {}，而不是 am-hook 页面", status.as_u16()),
            &base_url,
        ));
    }
    if !content_type.contains("text/html") {
        return Err(CheckError::new(
            "not-am-hook",
            format!("这个地址返回的不是网页（{content_type}）"),
            &base_url,
        ));
    }
    // 只确认它引用了 /assets/ 下的资源；页面标题、品牌名可以按部署改，
    // 真正的 am-hook 标识由 host.js 与 decrypt.js 判断。
    if !html.contains("/assets/") {
        return Err(CheckError::new(
            "not-am-hook",
            "这个网页不是 am-hook：没有找到 am-hook 的页面资源",
            &base_url,
        ));
    }

    let host_js_url = format!("{base_url}assets/host.js");
    let (status, headers, _content_type, host_js) = get_text(client, &host_js_url).await?;
    if is_challenge(status, &headers, &host_js) {
        return Err(challenge_error(&base_url));
    }
    if !status.is_success() || !host_js.contains("AM_HOOK_HOST") {
        return Err(CheckError::new(
            "not-am-hook",
            "这个网页不是 am-hook：缺少 /assets/host.js 里的运行参数",
            &base_url,
        ));
    }

    let decrypt_url = format!("{base_url}assets/decrypt.js");
    let (status, headers, _content_type, decrypt_js) = get_text(client, &decrypt_url).await?;
    if is_challenge(status, &headers, &decrypt_js) {
        return Err(challenge_error(&base_url));
    }
    let decrypt = status.is_success() && decrypt_js.contains("openTrack");
    if !decrypt {
        return Err(CheckError::new(
            "incompatible",
            "这个 am-hook 版本没有浏览器内解密（/assets/decrypt.js 里没有 openTrack），无法把音频交给 mpv",
            &base_url,
        ));
    }

    // 页面标题
    let title = html
        .split("<title>")
        .nth(1)
        .and_then(|rest| rest.split("</title>").next())
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "am-hook".to_string());

    // /status 是转发 wrapper-lite 的状态；--local-wrapper-only 时是 501 + 同样的 JSON
    let mut info = ServerInfo {
        url: base_url.clone(),
        title,
        decrypt,
        wrapper_relay: None,
        regions: Vec::new(),
        wrapper_url: None,
        checked_at: Some(std::time::Instant::now()),
    };
    let status_url = format!("{base_url}status");
    if let Ok((_, _, _, text)) = get_text(client, &status_url).await {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if let Some(regions) = value.get("regions").and_then(Value::as_array) {
                info.regions = regions.iter().filter_map(Value::as_str).map(str::to_string).collect();
            }
            if let Some(wrapper) = value.get("wrapperUrl").and_then(Value::as_str) {
                info.wrapper_relay = Some(!wrapper.is_empty());
                if !wrapper.is_empty() {
                    info.wrapper_url = Some(wrapper.to_string());
                }
            } else if value.get("code").is_some() {
                info.wrapper_relay = Some(false);
            }
        }
    }
    Ok(info)
}

/// 轻量探活：只取 `/assets/host.js`，确认服务器还活着而且仍是 am-hook
pub async fn ping(client: &reqwest::Client, base_url: &str) -> Result<(), String> {
    let url = format!("{}assets/host.js", base_url.trim_end_matches('/').to_string() + "/");
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(6))
        .send()
        .await
        .map_err(|error| friendly(&error))?;
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.text().await.map_err(|error| friendly(&error))?;
    if is_challenge(status, &headers, &body) {
        // 能拿到挑战页说明服务器可达；浏览器里的页面会自己完成验证，
        // 这里不能把挑战当成掉线，否则页面顶部会一直显示断线横幅。
        return Ok(());
    }
    if !status.is_success() {
        return Err(format!("服务器返回 HTTP {}", status.as_u16()));
    }
    if !body.contains("AM_HOOK_HOST") {
        return Err("目标不再是 am-hook".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_addresses() {
        assert_eq!(normalize("127.0.0.1:8888").unwrap().as_str(), "http://127.0.0.1:8888/");
        assert_eq!(normalize("http://example.com/song/1?x=2").unwrap().as_str(), "http://example.com/");
        assert_eq!(normalize(" https://music.example.com:8443 ").unwrap().as_str(), "https://music.example.com:8443/");
        assert!(normalize("").is_err());
        assert!(normalize("ftp://example.com").is_err());
        assert!(normalize("http://").is_err());
    }

    #[test]
    fn detects_cloudflare_challenge() {
        let headers = HeaderMap::new();
        assert!(is_challenge(
            reqwest::StatusCode::FORBIDDEN,
            &headers,
            "<title>Just a moment...</title>"
        ));
        let challenge = HeaderMap::from_iter([(
            reqwest::header::HeaderName::from_static("cf-mitigated"),
            reqwest::header::HeaderValue::from_static("challenge"),
        )]);
        assert!(is_challenge(reqwest::StatusCode::OK, &challenge, "<html></html>"));
        assert!(!is_challenge(
            reqwest::StatusCode::OK,
            &headers,
            "<title>am-hook</title><script src=\"/assets/app.mjs\"></script>"
        ));
    }
}
