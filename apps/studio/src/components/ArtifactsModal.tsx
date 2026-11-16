import { useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, X } from 'lucide-react';

import { formatBytes, kindLabel, revealArtifact } from '../file-format';

interface ArtifactFile {
  path: string;
  absolutePath?: string;
  bytes: number;
  kind: string;
  source?: string;
  taskId?: string;
  createdAt?: number;
}

interface ArtifactRun {
  runId: string;
  workspaceId: string;
  updatedAt: number;
  files: ArtifactFile[];
}

/**
 * 聚合视图：这个工作区里，每次运行到底交付了哪些文件。
 * 用户的原话是「我让他做个 PDF，画布上看不到这个 PDF 在哪」——这里把位置、
 * 体积、类型、产出它的任务一次列全，点一下就能在资源管理器里定位或读内容。
 */
export function ArtifactsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [runs, setRuns] = useState<ArtifactRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/artifacts?limit=20');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { runs?: ArtifactRun[] };
      setRuns(payload.runs ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open]);

  if (!open) return null;

  const openPreview = async (file: ArtifactFile) => {
    if (!file.absolutePath) return;
    try {
      const response = await fetch(`/api/artifacts/preview?path=${encodeURIComponent(file.absolutePath)}`);
      if (!response.ok) return;
      const type = response.headers.get('content-type') ?? '';
      if (!type.includes('application/json')) {
        // 图片/PDF：直接新窗口打开服务端返回的字节。
        window.open(`/api/artifacts/preview?path=${encodeURIComponent(file.absolutePath)}`, '_blank');
        return;
      }
      const payload = (await response.json()) as { text?: string; path?: string };
      setPreview({ path: payload.path ?? file.path, text: payload.text ?? '' });
    } catch {
      // 预览失败就只保留定位按钮
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal report-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <strong>产物</strong>
            <span className="muted"> · 每次运行真正落盘的文件</span>
          </div>
          <div className="report-head-actions">
            <button className="mini-btn" onClick={() => void load()} title="刷新">
              <RefreshCw size={12} /> 刷新
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="关闭">
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="report-body">
          {error && <div className="empty">读取失败：{error}</div>}
          {!error && loading && <div className="empty">读取中…</div>}
          {!error && !loading && runs.length === 0 && (
            <div className="empty">还没有产物。跑一次会写文件的编排，这里就会出现交付物。</div>
          )}

          {runs.map((run) => (
            <div key={run.runId} className="report-task">
              <div className="report-task-head">
                <strong>{run.runId}</strong>
                <span className="report-task-id">
                  {new Date(run.updatedAt).toLocaleString()} · {run.files.length} 个产物
                </span>
              </div>
              <div className="report-files">
                {run.files.map((file) => (
                  <div key={file.absolutePath ?? file.path} className="artifact-row">
                    <span className={`node-file-kind ${file.kind}`}>{kindLabel(file.kind)}</span>
                    <span className="artifact-path" title={file.absolutePath ?? file.path}>
                      {file.path}
                    </span>
                    <span className="node-file-size">{formatBytes(file.bytes)}</span>
                    {file.taskId && <span className="artifact-task">{file.taskId}</span>}
                    <button className="mini-btn" onClick={() => void openPreview(file)}>
                      预览
                    </button>
                    <button className="mini-btn" onClick={() => void revealArtifact(file.absolutePath)}>
                      <FolderOpen size={11} /> 定位
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {preview && (
          <div className="artifact-preview">
            <div className="artifact-preview-head">
              <code>{preview.path}</code>
              <button className="icon-btn" onClick={() => setPreview(null)} aria-label="关闭预览">
                <X size={13} />
              </button>
            </div>
            <pre className="report-output">{preview.text.slice(0, 20000)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
