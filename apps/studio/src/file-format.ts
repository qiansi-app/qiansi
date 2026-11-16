/** 产物展示用的小工具：体积、类型标签、显示名。 */

export function formatBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 类型角标：PDF / IMG / XLS / TXT / CODE / FILE。 */
export function kindLabel(kind?: string): string {
  switch (kind) {
    case 'pdf':
      return 'PDF';
    case 'image':
      return 'IMG';
    case 'data':
      return 'DATA';
    case 'archive':
      return 'ZIP';
    case 'code':
      return 'CODE';
    case 'text':
      return 'TXT';
    default:
      return 'FILE';
  }
}

export function shortFileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 打开文件所在位置（服务端只接受账本里登记过的路径）。 */
export async function revealArtifact(path?: string): Promise<boolean> {
  if (!path) return false;
  try {
    const response = await fetch('/api/artifacts/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
