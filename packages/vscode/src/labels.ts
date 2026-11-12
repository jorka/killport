import * as vscode from 'vscode';

/** Your own names for ports, from the `killport.portLabels` setting: { "3000": "rezicard front" }. */
export function getPortLabels(): Record<string, string> {
  const raw = vscode.workspace.getConfiguration('killport').get<Record<string, unknown>>('portLabels', {});
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) if (/^\d+$/.test(k) && typeof v === 'string' && v.trim()) out[k] = v.trim();
  return out;
}

/** Asks for a label for `port` (or for a port first) and saves it. An empty label removes it. */
export async function editPortLabel(port?: number): Promise<void> {
  if (port === undefined) {
    const input = await vscode.window.showInputBox({
      prompt: 'Which port do you want to label?',
      placeHolder: '3000',
      validateInput: (v) => (/^\d{1,5}$/.test(v.trim()) && Number(v) <= 65535 ? undefined : 'Enter a port number'),
    });
    if (!input) return;
    port = Number(input.trim());
  }
  const labels = getPortLabels();
  const value = await vscode.window.showInputBox({
    prompt: `Label for port ${port} (leave empty to remove)`,
    placeHolder: 'e.g. rezicard front',
    value: labels[port] ?? '',
  });
  if (value === undefined) return;
  if (value.trim()) labels[port] = value.trim();
  else delete labels[port];
  await vscode.workspace.getConfiguration('killport').update('portLabels', labels, vscode.ConfigurationTarget.Global);
}
