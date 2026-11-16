import { FolderOpen } from 'lucide-react';

import { formatBytes, kindLabel, revealArtifact, shortFileName } from '../file-format';
import type { RunTaskFile } from '../types';

/**
 * 节点上的产物条：文件名、体积、类型角标，点一下在资源管理器里定位。
 * 画布上终于能看见「这一步到底交付了什么」，而不是只有一段文字。
 */
export function NodeFiles({
  files,
  limit = 3,
  onReveal,
}: {
  files?: RunTaskFile[];
  limit?: number;
  onReveal?: (absolutePath?: string) => void;
}) {
  if (!files?.length) return null;
  const shown = files.slice(0, limit);
  return (
    <div className="node-files">
      {shown.map((file) => (
        <button
          key={file.absolutePath ?? file.path}
          type="button"
          className={`node-file ${file.kind}`}
          title={`${file.path}${file.source ? ` · 来源 ${file.source}` : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            if (onReveal) onReveal(file.absolutePath);
            else void revealArtifact(file.absolutePath);
          }}
        >
          <span className="node-file-kind">{kindLabel(file.kind)}</span>
          <span className="node-file-name">{shortFileName(file.path)}</span>
          <span className="node-file-size">{formatBytes(file.bytes)}</span>
          <FolderOpen size={10} className="node-file-open" />
        </button>
      ))}
      {files.length > shown.length && (
        <span className="node-file-more">+{files.length - shown.length} 个产物</span>
      )}
    </div>
  );
}
