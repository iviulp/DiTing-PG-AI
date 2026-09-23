//! WP2: OpenAI 兼容 SSE (Server-Sent Events) 增量解析器 — 纯逻辑模块, 与 reqwest/Channel 解耦
//! 处理: 半行跨 chunk 缓冲、UTF-8 多字节跨 chunk 切断、data: [DONE]、
//!       注释行 (:xxx)、空行/心跳、CRLF 行尾、delta.content 为 null、非法 JSON 帧跳过。

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct StreamChunkResp {
    choices: Option<Vec<StreamChoice>>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: Option<StreamDelta>,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    content: Option<String>,
}

#[derive(Debug, Default)]
pub struct SseParser {
    /// 未完成行的字节缓冲 (处理半行 + UTF-8 跨 chunk 切断)
    pending: Vec<u8>,
    /// 收到 data: [DONE] 后置位
    pub finished: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入一段网络字节, 返回本批解析出的全部 delta 文本 (顺序与流一致)
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        self.pending.extend_from_slice(chunk);

        while let Some(newline_pos) = self.pending.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = self.pending.drain(..=newline_pos).collect();
            // 去掉行尾 \n 与可能的 \r (CRLF)
            let mut line = line_bytes;
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            // UTF-8 解码: 行内若仍有多字节切断 (理论上不应发生, 因切在 \n), 跳过
            let line_str = match String::from_utf8(line) {
                Ok(s) => s,
                Err(_) => continue,
            };

            let trimmed = line_str.trim();
            // 空行 = SSE 事件分隔符 / 心跳
            if trimmed.is_empty() {
                continue;
            }
            // 注释行 (以 : 开头)
            if trimmed.starts_with(':') {
                continue;
            }
            // 只处理 data: 字段
            if let Some(payload) = trimmed.strip_prefix("data:") {
                let payload = payload.trim();
                if payload == "[DONE]" {
                    self.finished = true;
                    continue;
                }
                match serde_json::from_str::<StreamChunkResp>(payload) {
                    Ok(resp) => {
                        if let Some(choice) = resp.choices.and_then(|c| c.into_iter().next()) {
                            if let Some(delta) = choice.delta {
                                if let Some(text) = delta.content {
                                    if !text.is_empty() {
                                        out.push(text);
                                    }
                                }
                            }
                        }
                    }
                    Err(_) => {
                        // 非法 JSON 帧: 跳过不崩
                        continue;
                    }
                }
            }
            // 其他 SSE 字段 (event:/id:/retry:) 忽略
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(content: &str) -> String {
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{}\"}}}}]}}\n\n",
            content
        )
    }

    #[test]
    fn standard_multi_frame() {
        let stream = format!("{}{}data: [DONE]\n\n", frame("Hello"), frame(" World"));
        let mut p = SseParser::new();
        let deltas = p.feed(stream.as_bytes());
        assert_eq!(deltas, vec!["Hello", " World"]);
        assert!(p.finished);
    }

    #[test]
    fn byte_by_byte_feed_same_output() {
        // 任意切分方式 (含单字节逐字喂入, 制造半行 + UTF-8 切断) 输出必须一致
        let stream = format!(
            "{}{}{}data: [DONE]\n\n",
            frame("你"),
            frame("好"),
            frame("world")
        );
        // 一次性
        let mut p1 = SseParser::new();
        let whole = p1.feed(stream.as_bytes());
        // 逐字节
        let mut p2 = SseParser::new();
        let mut bytewise = Vec::new();
        for b in stream.as_bytes() {
            bytewise.extend(p2.feed(&[*b]));
        }
        assert_eq!(whole, bytewise);
        assert_eq!(whole, vec!["你", "好", "world"]);
        assert!(p2.finished);
    }

    #[test]
    fn done_marker() {
        let mut p = SseParser::new();
        p.feed(b"data: [DONE]\n\n");
        assert!(p.finished);
        let deltas = p.feed(b"data: [DONE]\n\n");
        assert!(deltas.is_empty());
    }

    #[test]
    fn comment_and_empty_lines_ignored() {
        let stream = format!(": heartbeat\n\n\n{}data: [DONE]\n\n", frame("ok"));
        let mut p = SseParser::new();
        assert_eq!(p.feed(stream.as_bytes()), vec!["ok"]);
    }

    #[test]
    fn crlf_line_endings() {
        let stream = "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n";
        let mut p = SseParser::new();
        assert_eq!(p.feed(stream.as_bytes()), vec!["x"]);
        assert!(p.finished);
    }

    #[test]
    fn null_delta_content_skipped() {
        // 首帧常见: delta 只有 role 无 content
        let stream = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n";
        let mut p = SseParser::new();
        assert!(p.feed(stream.as_bytes()).is_empty());
        assert!(!p.finished);
    }

    #[test]
    fn invalid_json_frame_skipped_no_crash() {
        let stream = format!("data: {{not json}}\n\n{}data: [DONE]\n\n", frame("good"));
        let mut p = SseParser::new();
        assert_eq!(p.feed(stream.as_bytes()), vec!["good"]);
        assert!(p.finished);
    }

    #[test]
    fn multiple_choices_takes_first() {
        let stream = "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}},{\"delta\":{\"content\":\"b\"}}]}\n\ndata: [DONE]\n\n";
        let mut p = SseParser::new();
        assert_eq!(p.feed(stream.as_bytes()), vec!["a"]);
    }

    #[test]
    fn empty_content_string_skipped() {
        let stream = format!("{}data: [DONE]\n\n", frame(""));
        let mut p = SseParser::new();
        assert!(p.feed(stream.as_bytes()).is_empty());
    }
}
