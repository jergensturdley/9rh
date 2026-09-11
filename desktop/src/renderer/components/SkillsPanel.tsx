/**
 * Skills discovered for a session's workdir (main runs `discoverSkills`).
 * Read-only: name, source, description, and the SKILL.md path with a copy
 * button. Refresh re-runs discovery so a skill dropped into
 * ~/.9rh/skills/<name>/SKILL.md shows up without a new session.
 */

import { useState } from "react";
import type { SkillManifestEntry } from "9rh";
import { useAsync } from "@renderer/state/useAsync";
import { Badge, Button, EmptyState, ErrorNote, Spinner } from "./ui";

// ponytail: no co-located stylesheet for this panel, so the few layout rules
// live inline. Move them to SkillsPanel.css if the table grows a theme.
const cell: React.CSSProperties = { padding: "6px 8px", verticalAlign: "top", borderBottom: "1px solid var(--border)" };
const mono: React.CSSProperties = { ...cell, fontFamily: "var(--font-mono)", fontSize: 12, overflowWrap: "anywhere" };

export function SkillsPanel({ sessionId }: { sessionId: string }) {
  const skills = useAsync(() => window.ninerh.sessions.skills(sessionId), [sessionId]);
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, flex: 1 }}>Skills</h3>
        <Button size="sm" variant="ghost" disabled={skills.loading} onClick={() => void skills.refresh()}>
          Refresh
        </Button>
      </header>
      {skills.error ? <ErrorNote message={skills.error} onRetry={() => void skills.refresh()} /> : null}
      {skills.data === null && !skills.error ? <Spinner /> : null}
      {skills.data && skills.data.length === 0 ? (
        <EmptyState title="No skills found" hint="Add one at ~/.9rh/skills/<name>/SKILL.md (or .9rh/skills inside the workdir) and refresh." />
      ) : null}
      {skills.data && skills.data.length > 0 ? (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
              <th style={cell}>name</th>
              <th style={cell}>source</th>
              <th style={cell}>description</th>
              <th style={cell}>path</th>
            </tr>
          </thead>
          <tbody>
            {skills.data.map((s) => (
              <SkillRow key={s.path} skill={s} />
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function SkillRow({ skill }: { skill: SkillManifestEntry }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(skill.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <tr>
      <td style={mono}>{skill.name}</td>
      <td style={cell}>
        <Badge tone={skill.source.startsWith("workdir") ? "accent" : "muted"}>{skill.source}</Badge>
      </td>
      <td style={cell}>{skill.description}</td>
      <td style={mono}>
        <span title={skill.path}>{skill.path}</span>{" "}
        <Button size="sm" variant="ghost" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </td>
    </tr>
  );
}
