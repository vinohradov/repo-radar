import { Fragment, type ReactNode } from "react";

/** Inline **bold** → <strong>. */
function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <Fragment key={i}>{p}</Fragment>,
  );
}

/** Tiny markdown renderer for the human report (headings, lists, tables). */
export function MarkdownView({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^#{1,3}\s+/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const text = line.replace(/^#+\s+/, "");
      const Tag = (`h${Math.min(level + 1, 4)}`) as "h2" | "h3" | "h4";
      blocks.push(<Tag key={key++} style={{ marginTop: level === 1 ? 0 : 18, marginBottom: 8 }}>{text}</Tag>);
      i++;
      continue;
    }

    // table
    if (line.trim().startsWith("|") && lines[i + 1]?.includes("---")) {
      const header = line.split("|").slice(1, -1).map((c) => c.trim());
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim().replace(/\\\|/g, "|")));
        i++;
      }
      blocks.push(
        <table key={key++}>
          <thead>
            <tr>{header.map((h, hi) => <th key={hi}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // bullet list
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} style={{ margin: "6px 0", paddingLeft: 22 }}>
          {items.map((it, ii) => <li key={ii}>{inline(it)}</li>)}
        </ul>,
      );
      continue;
    }

    // numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} style={{ margin: "6px 0", paddingLeft: 22 }}>
          {items.map((it, ii) => <li key={ii}>{inline(it)}</li>)}
        </ol>,
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    blocks.push(<p key={key++} style={{ margin: "6px 0" }}>{inline(line)}</p>);
    i++;
  }

  return <div className="report-view">{blocks}</div>;
}

export function JsonView({ content }: { content: string }) {
  return <pre className="code-block">{content}</pre>;
}
