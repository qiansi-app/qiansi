import { Loader2, RefreshCw, X } from 'lucide-react';
import type { UserViewReport } from '../types';

interface UserViewModalProps {
  report: UserViewReport | null;
  open: boolean;
  busy?: boolean;
  onClose: () => void;
  onRecheck?: () => void;
}

/**
 * 用户视角验收的结果：一句话结论、逐项检查、桌面与手机截图。
 * 截图是「真的打开过」的证据，不是模型的一句「没问题」。
 */
export function UserViewModal({ report, open, busy, onClose, onRecheck }: UserViewModalProps) {
  if (!open || !report) return null;
  const verdictLabel =
    report.verdict === 'pass' ? '通过' : report.verdict === 'fail' ? '未通过' : '无法验收';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal user-view-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">用户视角验收 · {verdictLabel}</div>
            <div className="modal-sub">
              {report.kind} · {report.url || report.rootDir} · 用时{' '}
              {(report.durationMs / 1000).toFixed(1)}s
            </div>
          </div>
          <button className="icon-tool" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="user-view-body">
          <div className={`user-view-verdict ${report.verdict}`}>{report.summary}</div>

          {report.checks.length > 0 && (
            <ul className="user-view-checks">
              {report.checks.map((check) => (
                <li
                  key={check.name}
                  className={check.ok ? 'ok' : check.soft ? 'warn' : 'bad'}
                >
                  <b>{check.ok ? '✓' : check.soft ? '!' : '✗'}</b>
                  <span className="user-view-check-label">{check.label}</span>
                  {check.detail && <span className="user-view-check-detail">{check.detail}</span>}
                </li>
              ))}
            </ul>
          )}

          {report.shots.length > 0 ? (
            <div className="user-view-shots">
              {report.shots.map((shot) => (
                <figure key={shot.label}>
                  <img
                    src={`/api/user-view/${report.id}/shot/${shot.label}`}
                    alt={shot.label === 'desktop' ? '桌面截图' : '手机截图'}
                    loading="lazy"
                  />
                  <figcaption>
                    {shot.label === 'desktop' ? '桌面 1440×900' : '手机 390×844'} ·{' '}
                    {(shot.bytes / 1024).toFixed(0)}KB
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <div className="user-view-noshot">这次没有截图（项目没有启动起来）。</div>
          )}

          {report.pageText && (
            <details className="user-view-text">
              <summary>页面上用户看到的文字</summary>
              <pre>{report.pageText}</pre>
            </details>
          )}
        </div>

        <div className="user-view-foot">
          <span className="muted">{report.error ? report.error.slice(0, 240) : '检查项以真实浏览器为准'}</span>
          {onRecheck && (
            <button className="btn" onClick={onRecheck} disabled={busy}>
              {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              {busy ? '验收中…' : '重新验收'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
