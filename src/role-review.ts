import type { ExtensionContext } from "@ableton-extensions/sdk";
import {
  inferTrackRoleFromHierarchy,
  type TrackRole,
} from "./analysis.js";
import type { JamSource } from "./jam-source.js";

export type ReviewedRole = TrackRole | "ignore";

export interface ReviewedSource {
  source: JamSource;
  role: ReviewedRole;
  groupNames: string[];
}

const ROLE_OPTIONS: Array<{ value: ReviewedRole; label: string }> = [
  { value: "harmony", label: "Harmony / Chords" },
  { value: "melody", label: "Melody / Lead" },
  { value: "drums", label: "Drums / Breaks" },
  { value: "bass", label: "Bass" },
  { value: "texture", label: "Texture / FX" },
  { value: "balanced", label: "General" },
  { value: "ignore", label: "Ignore for detection" },
];

function hierarchy(source: JamSource): string[] {
  const names: string[] = [];
  const visited = new Set<bigint>();
  let group = source.track.groupTrack;
  while (group && !visited.has(group.handle.id)) {
    visited.add(group.handle.id);
    names.push(group.name);
    group = group.groupTrack;
  }
  return names;
}

function dialogHtml(rows: Array<{ index: number; name: string; groups: string[]; role: TrackRole }>): string {
  const data = JSON.stringify({ rows, roles: ROLE_OPTIONS }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#1e1e1e;color:#eee;font:13px system-ui,-apple-system,sans-serif}header{position:sticky;top:0;background:#252525;padding:20px 22px 13px;border-bottom:1px solid #444;z-index:2}h1{font-size:19px;margin:0 0 5px}p{margin:0;color:#bbb;line-height:1.35}.wrap{padding:12px 22px 84px}table{border-collapse:collapse;width:100%}th{text-align:left;color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:8px;border-bottom:1px solid #555}td{padding:8px;border-bottom:1px solid #383838}.track{font-weight:600}.group{color:#aaa;font-size:12px}select{width:100%;min-width:165px;background:#303030;color:#fff;border:1px solid #666;border-radius:4px;padding:6px}footer{position:fixed;bottom:0;left:0;right:0;background:#252525;border-top:1px solid #444;padding:13px 22px;display:flex;align-items:center;justify-content:space-between}.hint{color:#aaa;font-size:12px}.buttons{display:flex;gap:9px}button{border:1px solid #666;border-radius:4px;background:#353535;color:#fff;padding:8px 18px;font-weight:600}button.primary{background:#4f83cc;border-color:#6b9bdd}button:hover{filter:brightness(1.15)}
  </style></head><body><header><h1>Review Track Roles</h1><p>Jamology uses these roles to decide which sustained musical changes create sections. Correct any ambiguous instruments or submixes before analysis.</p></header><div class="wrap"><table><thead><tr><th>Selected track</th><th>Parent group</th><th>Analysis role</th></tr></thead><tbody id="rows"></tbody></table></div><footer><span class="hint">No recordings are read until you choose Analyze.</span><div class="buttons"><button id="cancel">Cancel</button><button class="primary" id="analyze">Analyze</button></div></footer><script>
    const model=${data};
    const tbody=document.getElementById('rows');
    for(const row of model.rows){const tr=document.createElement('tr');const track=document.createElement('td');track.className='track';track.textContent=row.name;const group=document.createElement('td');group.className='group';group.textContent=row.groups.length?row.groups.join(' › '):'—';const role=document.createElement('td');const select=document.createElement('select');select.dataset.index=String(row.index);for(const item of model.roles){const option=document.createElement('option');option.value=item.value;option.textContent=item.label;option.selected=item.value===row.role;select.appendChild(option)}role.appendChild(select);tr.append(track,group,role);tbody.appendChild(tr)}
    function send(value){const message={method:'close_and_send',params:[JSON.stringify(value)]};if(window.webkit?.messageHandlers?.live)window.webkit.messageHandlers.live.postMessage(message);else if(window.chrome?.webview)window.chrome.webview.postMessage(message)}
    document.getElementById('cancel').onclick=()=>send({action:'cancel'});
    document.getElementById('analyze').onclick=()=>send({action:'analyze',roles:[...document.querySelectorAll('select')].map(select=>({index:Number(select.dataset.index),role:select.value}))});
  </script></body></html>`;
}

export async function reviewTrackRoles(
  context: ExtensionContext<"1.0.0">,
  sources: readonly JamSource[],
): Promise<ReviewedSource[] | undefined> {
  const contexts = sources.map((source, index) => {
    const groupNames = hierarchy(source);
    return {
      source,
      groupNames,
      row: {
        index,
        name: source.track.name,
        groups: groupNames,
        role: inferTrackRoleFromHierarchy(source.track.name, groupNames),
      },
    };
  });
  const html = dialogHtml(contexts.map(({ row }) => row));
  const response = await context.ui.showModalDialog(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    760,
    680,
  );
  const parsed = JSON.parse(response) as {
    action?: string;
    roles?: Array<{ index: number; role: ReviewedRole }>;
  };
  if (parsed.action !== "analyze") return undefined;
  const choices = new Map(parsed.roles?.map(({ index, role }) => [index, role]));
  return contexts.map(({ source, groupNames, row }, index) => ({
    source,
    groupNames,
    role: choices.get(index) ?? row.role,
  }));
}
