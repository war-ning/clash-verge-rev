//! 极简 xlsx 写出器。
//!
//! xlsx 本质是一个装着若干 XML 的 zip 包，项目里已经有 `zip` 依赖，
//! 因此这里直接手写所需的几个 XML 部件，不再引入表格库。
//!
//! 只实现「多工作表 + 文本/数值单元格」这一最小集合：
//! 字符串走 inlineStr（省掉 sharedStrings 部件），数值直接写 `<v>`，
//! 足够承载导出报表，也避免了大而全的依赖。

use anyhow::Result;
use std::io::{Cursor, Write as _};
use zip::write::SimpleFileOptions;

/// 单元格取值。
#[derive(Debug, Clone)]
pub enum Cell {
    Text(String),
    /// 整数（字节数这类计数用它，避免浮点精度损失）。
    Int(u64),
    /// 小数（百分比这类用它）。
    Float(f64),
}

impl Cell {
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }
}

/// 一张工作表。
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<Cell>>,
}

/// Excel 工作表名的非法字符与长度限制。
const INVALID_SHEET_CHARS: [char; 7] = ['\\', '/', '?', '*', '[', ']', ':'];
const MAX_SHEET_NAME_LEN: usize = 31;

/// 把工作表名收拾成 Excel 能接受的形式（非法字符换成下划线并截断）。
fn sanitize_sheet_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| if INVALID_SHEET_CHARS.contains(&ch) { '_' } else { ch })
        .take(MAX_SHEET_NAME_LEN)
        .collect();

    if cleaned.trim().is_empty() {
        "Sheet".to_owned()
    } else {
        cleaned
    }
}

/// XML 文本转义；顺带丢掉 XML 1.0 不允许出现的控制字符。
fn escape_xml(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(ch),
            ch if (ch as u32) < 0x20 => {}
            ch => out.push(ch),
        }
    }
    out
}

/// 0 -> A、25 -> Z、26 -> AA，Excel 的列名规则。
fn column_name(mut index: usize) -> String {
    let mut name = Vec::new();
    loop {
        name.push(b'A' + u8::try_from(index % 26).unwrap_or(0));
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    name.reverse();
    String::from_utf8(name).unwrap_or_else(|_| "A".to_owned())
}

fn cell_xml(reference: &str, cell: &Cell) -> String {
    match cell {
        Cell::Text(value) => format!(
            r#"<c r="{reference}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
            escape_xml(value)
        ),
        Cell::Int(value) => format!(r#"<c r="{reference}"><v>{value}</v></c>"#),
        Cell::Float(value) => format!(r#"<c r="{reference}"><v>{value}</v></c>"#),
    }
}

fn sheet_xml(sheet: &Sheet) -> String {
    let mut body = String::new();
    for (row_index, row) in sheet.rows.iter().enumerate() {
        let row_number = row_index + 1;
        body.push_str(&format!(r#"<row r="{row_number}">"#));
        for (col_index, cell) in row.iter().enumerate() {
            let reference = format!("{}{row_number}", column_name(col_index));
            body.push_str(&cell_xml(&reference, cell));
        }
        body.push_str("</row>");
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{body}</sheetData></worksheet>"#
    )
}

fn content_types_xml(sheet_count: usize) -> String {
    let overrides: String = (1..=sheet_count)
        .map(|index| {
            format!(
                r#"<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#
            )
        })
        .collect();

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>{overrides}</Types>"#
    )
}

fn workbook_xml(sheets: &[Sheet]) -> String {
    let entries: String = sheets
        .iter()
        .enumerate()
        .map(|(index, sheet)| {
            let sheet_id = index + 1;
            format!(
                r#"<sheet name="{}" sheetId="{sheet_id}" r:id="rId{sheet_id}"/>"#,
                escape_xml(&sanitize_sheet_name(&sheet.name))
            )
        })
        .collect();

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{entries}</sheets></workbook>"#
    )
}

fn workbook_rels_xml(sheet_count: usize) -> String {
    let entries: String = (1..=sheet_count)
        .map(|index| {
            format!(
                r#"<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>"#
            )
        })
        .collect();

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{entries}</Relationships>"#
    )
}

const ROOT_RELS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;

/// 把若干工作表打包成 xlsx 字节流。
pub fn build_xlsx(sheets: &[Sheet]) -> Result<Vec<u8>> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::<u8>::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    writer.start_file("[Content_Types].xml", options)?;
    writer.write_all(content_types_xml(sheets.len()).as_bytes())?;

    writer.start_file("_rels/.rels", options)?;
    writer.write_all(ROOT_RELS_XML.as_bytes())?;

    writer.start_file("xl/workbook.xml", options)?;
    writer.write_all(workbook_xml(sheets).as_bytes())?;

    writer.start_file("xl/_rels/workbook.xml.rels", options)?;
    writer.write_all(workbook_rels_xml(sheets.len()).as_bytes())?;

    for (index, sheet) in sheets.iter().enumerate() {
        writer.start_file(format!("xl/worksheets/sheet{}.xml", index + 1), options)?;
        writer.write_all(sheet_xml(sheet).as_bytes())?;
    }

    Ok(writer.finish()?.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_names_follow_excel_rules() {
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
        assert_eq!(column_name(27), "AB");
        assert_eq!(column_name(51), "AZ");
        assert_eq!(column_name(52), "BA");
    }

    #[test]
    fn escapes_xml_specials_and_drops_control_chars() {
        assert_eq!(escape_xml("a<b>&\"c\'"), "a&lt;b&gt;&amp;&quot;c&apos;");
        // 复合键分隔符这类控制字符必须被丢掉，否则 Excel 打不开
        assert_eq!(escape_xml("a\u{1}b"), "ab");
        // 制表/换行是合法的
        assert_eq!(escape_xml("a\tb"), "a\tb");
    }

    #[test]
    fn sheet_names_are_sanitized() {
        assert_eq!(sanitize_sheet_name("a/b:c"), "a_b_c");
        assert_eq!(sanitize_sheet_name(""), "Sheet");
        assert_eq!(sanitize_sheet_name(&"x".repeat(40)).chars().count(), 31);
    }

    #[test]
    fn builds_a_readable_zip() {
        let sheets = vec![Sheet {
            name: "汇总".to_owned(),
            rows: vec![
                vec![Cell::text("名称"), Cell::text("字节")],
                vec![Cell::text("example.com"), Cell::Int(1024)],
            ],
        }];

        let bytes = build_xlsx(&sheets).expect("build");
        // zip 魔数
        assert_eq!(&bytes[0..2], b"PK");

        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("open zip");
        let names: Vec<String> = archive.file_names().map(str::to_owned).collect();
        for required in [
            "[Content_Types].xml",
            "_rels/.rels",
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/worksheets/sheet1.xml",
        ] {
            assert!(names.iter().any(|name| name == required), "缺少 {required}");
        }

        let mut sheet = String::new();
        {
            use std::io::Read as _;
            archive
                .by_name("xl/worksheets/sheet1.xml")
                .expect("sheet1")
                .read_to_string(&mut sheet)
                .expect("read");
        }
        assert!(sheet.contains("example.com"));
        assert!(sheet.contains("<v>1024</v>"));
        assert!(sheet.contains(r#"r="B2""#));
    }
}
