//! 命令行参数拆分：与设置界面里写法保持一致，按空白拆开并支持单双引号，
//! 例如 `--ad-joc-hrtf="C:\Program Files\JOC\hrtf.bin"`。

/// 把一段参数文本拆成参数列表（最多 64 个，超长参数直接丢弃）
pub fn split_args(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for ch in text.chars() {
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            started = true;
            continue;
        }
        if ch.is_whitespace() {
            if started || !current.is_empty() {
                out.push(std::mem::take(&mut current));
                started = false;
            }
            continue;
        }
        current.push(ch);
        started = true;
    }
    if started || !current.is_empty() {
        out.push(current);
    }
    out.into_iter().filter(|arg| !arg.is_empty() && arg.len() <= 500).take(64).collect()
}

#[cfg(test)]
mod tests {
    use super::split_args;

    #[test]
    fn splits_plain_and_quoted() {
        assert_eq!(split_args("--a=1 --b=2"), vec!["--a=1", "--b=2"]);
        assert_eq!(
            split_args(r#"--ad-joc-hrtf="C:\Program Files\JOC\hrtf.bin" --x"#),
            vec![r"--ad-joc-hrtf=C:\Program Files\JOC\hrtf.bin", "--x"]
        );
        assert_eq!(split_args("   "), Vec::<String>::new());
        assert_eq!(split_args("--a 'b c' d"), vec!["--a", "b c", "d"]);
    }
}
