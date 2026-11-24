import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, Cloud, CloudUpload, FolderOpen, HardDrive, LoaderCircle, LogOut, RefreshCw, ShieldCheck, Smartphone, X } from 'lucide-react';
import type { DriveConfigUpdate, DriveStatus } from '../../shared/drive-types';

const emptyStatus: DriveStatus = {
  config: { desktopClientId: '', secretConfigured: false, sourceDirectory: '', autoSync: false },
  connected: false, connecting: false, phase: 'idle', filesTotal: 0, filesDone: 0,
  uploaded: 0, skipped: 0, failed: 0, bytesUploaded: 0, bytesTotal: 0, progress: 0,
};
interface Props {
  visible: boolean; fail: (message: string) => void; success: (message: string) => void;
  requireDesktop: () => boolean; onNavigateLinks: () => void;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function bytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: index ? 1 : 0 }).format(value / 1024 ** index)} ${units[index]}`;
}
function syncDate(value?: string) {
  if (!value) return 'Chưa đồng bộ lần nào';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(date) : 'Chưa có thời gian hợp lệ';
}

export default function DriveSettings({ visible, fail, success, requireDesktop, onNavigateLinks }: Props) {
  const [status, setStatus] = useState<DriveStatus>(emptyStatus);
  const [draft, setDraft] = useState<DriveConfigUpdate>({ desktopClientId: '', desktopClientSecret: '', sourceDirectory: '', autoSync: false });
  const [loading, setLoading] = useState(Boolean(window.music));
  const [loadError, setLoadError] = useState('');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const connectRequest = useRef(0);
  const syncRequest = useRef(0);
  const revision = useRef(0);
  const applyStatus = useCallback((next: DriveStatus, forceDraft = false) => {
    setStatus(next);
    if (forceDraft || !dirtyRef.current) {
      setDraft({ desktopClientId: next.config.desktopClientId, desktopClientSecret: '', sourceDirectory: next.config.sourceDirectory, autoSync: next.config.autoSync });
      dirtyRef.current = false; setDirty(false);
    }
  }, []);
  useEffect(() => {
    const api = window.music;
    if (!api) return;
    if (typeof api.driveStatus !== 'function' || typeof api.onDriveStatus !== 'function') { setLoading(false); setLoadError('Mở bản Luma hỗ trợ đồng bộ Google Drive để dùng tính năng này.'); return; }
    let active = true;
    const off = api.onDriveStatus(next => { ++revision.current; if (active) applyStatus(next); });
    const initialRevision = revision.current;
    void api.driveStatus().then(next => { if (active && revision.current === initialRevision) applyStatus(next); }).catch(error => { if (active) setLoadError(errorText(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; off(); };
  }, [applyStatus]);
  const change = <K extends keyof DriveConfigUpdate>(key: K, value: DriveConfigUpdate[K]) => {
    dirtyRef.current = true; setDirty(true); setDraft(current => ({ ...current, [key]: value }));
  };
  const busy = status.phase === 'scanning' || status.phase === 'uploading' || syncing;
  const waitingForGoogle = connecting || status.connecting || status.phase === 'connecting';
  const chooseDirectory = async () => {
    if (!requireDesktop() || choosing) return; setChoosing(true);
    try { const directory = await window.music!.chooseDriveDirectory(); if (directory) change('sourceDirectory', directory); }
    catch (error) { fail(errorText(error)); }
    finally { setChoosing(false); }
  };
  const reloadStatus = async () => {
    if (!requireDesktop() || loading) return;
    if (typeof window.music!.driveStatus !== 'function') { fail('Cần mở bản Luma hỗ trợ đồng bộ Google Drive.'); return; }
    setLoading(true);
    try { applyStatus(await window.music!.driveStatus()); setLoadError(''); }
    catch (error) { setLoadError(errorText(error)); }
    finally { setLoading(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!requireDesktop() || saving || busy) return; setSaving(true);
    try {
      const next = await window.music!.saveDriveConfig({ desktopClientId: draft.desktopClientId?.trim() || '', sourceDirectory: draft.sourceDirectory || '', autoSync: Boolean(draft.autoSync), ...(draft.desktopClientSecret?.trim() ? { desktopClientSecret: draft.desktopClientSecret.trim() } : {}) });
      applyStatus(next, true); success('Đã lưu thiết lập đồng bộ Google Drive.');
    } catch (error) { fail(errorText(error)); }
    finally { setSaving(false); }
  };
  const connect = async () => {
    if (!requireDesktop() || waitingForGoogle || busy || dirty) return;
    const request = ++connectRequest.current; setConnecting(true);
    try { const next = await window.music!.connectDrive(); if (request === connectRequest.current) { applyStatus(next); if (next.connected) success('Đã kết nối Google Drive.'); } }
    catch (error) { if (request === connectRequest.current) fail(errorText(error)); }
    finally { if (request === connectRequest.current) setConnecting(false); }
  };
  const cancelConnect = async () => {
    if (!requireDesktop()) return; ++connectRequest.current;
    try { await window.music!.cancelDriveConnect(); applyStatus(await window.music!.driveStatus()); }
    catch (error) { fail(errorText(error)); }
    finally { setConnecting(false); }
  };
  const disconnect = async () => {
    if (!requireDesktop() || busy || waitingForGoogle) return; setDisconnecting(true); ++connectRequest.current;
    try { applyStatus(await window.music!.disconnectDrive()); success('Đã ngắt kết nối Google Drive. Các file đã tải vẫn được giữ.'); }
    catch (error) { fail(errorText(error)); }
    finally { setDisconnecting(false); }
  };
  const syncNow = async () => {
    if (!requireDesktop() || busy || dirty || !status.connected) return;
    const request = ++syncRequest.current; setSyncing(true);
    try {
      const next = await window.music!.syncDriveNow();
      if (request === syncRequest.current) {
        applyStatus(next);
        if (next.phase === 'error' || next.failed) fail(next.message || `${next.failed} file chưa đồng bộ được. Xem chi tiết rồi thử lại.`);
        else success(`Đã đồng bộ: ${next.uploaded} file tải lên, ${next.skipped} file đã có.`);
      }
    } catch (error) { if (request === syncRequest.current) fail(errorText(error)); }
    finally { if (request === syncRequest.current) setSyncing(false); }
  };
  const cancelSync = async () => {
    if (!requireDesktop() || cancelling) return; ++syncRequest.current; setCancelling(true);
    try { applyStatus(await window.music!.cancelDriveSync()); }
    catch (error) { fail(errorText(error)); }
    finally { setSyncing(false); setCancelling(false); }
  };
  if (!visible) return null;
  const progress = Number.isFinite(status.progress) ? Math.max(0, Math.min(100, status.progress)) : 0;
  const hasConfiguration = Boolean(status.config.desktopClientId.trim());
  return <div className="settings-category-form drive-settings">
    <section className="drive-overview"><div className="drive-route" aria-hidden="true"><HardDrive size={22} /><i /><Cloud size={25} /><i /><Smartphone size={22} /></div><h3>PC → Google Drive → Android</h3><p>Luma tải FLAC, MP3, M4A từ thư mục bạn chọn lên thư mục <strong>LumaMusic</strong> do ứng dụng quản lý trên Google Drive. Trên Android, đăng nhập cùng tài khoản Google để tải nhạc về và nghe offline.</p><span><ShieldCheck size={13} /> Không sao chép thao tác xóa giữa các thiết bị.</span></section>
    {loading ? <div className="drive-loading" role="status"><LoaderCircle size={21} className="spin" /> Đang đọc trạng thái Google Drive…</div> : <>
      {loadError && <div className="drive-warning" role="alert"><AlertCircle size={18} /><span>{loadError}</span><button type="button" className="text-button" onClick={() => void reloadStatus()}>Thử lại</button></div>}
      {!hasConfiguration && <div className="drive-setup-note"><Cloud size={19} /><div><strong>Thiết lập Google OAuth một lần</strong><p>Cần Client ID loại <b>Desktop app</b> từ Google Cloud Console, bật Google Drive API rồi lưu ở bên dưới. Sau đó bấm Kết nối Google để tự đăng nhập trong trình duyệt.</p><button type="button" className="settings-inline-navigation" onClick={onNavigateLinks}>Mở hướng dẫn trong mục Liên kết <ArrowRight size={13} /></button></div></div>}
      <form onSubmit={event => void save(event)}>
        <section className="settings-card"><div className="settings-section-title"><Cloud size={21} /><div><h3>Ứng dụng Google Desktop</h3><p>Thông tin OAuth riêng cho Luma trên PC. Không nhập mật khẩu Google vào ứng dụng.</p></div>{dirty && <span className="drive-unsaved">Chưa lưu</span>}</div><div className="settings-tool-fields"><div><label className="field-label" htmlFor="drive-client-id">Desktop Client ID</label><input id="drive-client-id" autoComplete="off" maxLength={300} value={draft.desktopClientId || ''} placeholder="…apps.googleusercontent.com" disabled={saving || busy || waitingForGoogle} onChange={event => change('desktopClientId', event.target.value)} /></div><div><label className="field-label" htmlFor="drive-client-secret">Client Secret <span className="optional-label">nếu cấu hình OAuth yêu cầu</span></label><input id="drive-client-secret" type="password" autoComplete="new-password" maxLength={300} value={draft.desktopClientSecret || ''} placeholder={status.config.secretConfigured ? 'Đã lưu · để trống để giữ nguyên' : 'Tùy chọn cho Desktop OAuth client'} disabled={saving || busy || waitingForGoogle} onChange={event => change('desktopClientSecret', event.target.value)} /><p className="settings-help"><ShieldCheck size={13} /> Secret và token đăng nhập được mã hóa khi lưu trên máy; không lưu vào trình duyệt.</p></div></div></section>
        <section className="settings-card"><div className="settings-section-title"><HardDrive size={21} /><div><h3>Thư mục FLAC, MP3, M4A trên PC</h3><p>Chọn thư mục nguồn chứa các bản nhạc muốn đưa sang Android.</p></div></div><label className="field-label" htmlFor="drive-source-directory">Thư mục nguồn</label><div className="settings-input-row"><input id="drive-source-directory" value={draft.sourceDirectory || ''} readOnly placeholder="Chọn thư mục FLAC, MP3, M4A để đồng bộ" title={draft.sourceDirectory || ''} /><button type="button" className="subtle-button" disabled={choosing || saving || busy || waitingForGoogle} onClick={() => void chooseDirectory()}>{choosing ? <LoaderCircle size={15} className="spin" /> : <FolderOpen size={15} />} Chọn</button></div><label className="drive-auto-sync"><input type="checkbox" checked={Boolean(draft.autoSync)} disabled={saving || busy || waitingForGoogle} onChange={event => change('autoSync', event.target.checked)} /><span><strong>Tự động đồng bộ khi Luma đang chạy</strong><small>Kiểm tra file FLAC, MP3, M4A mới hoặc thay đổi mỗi 2 phút sau khi kết nối. Lựa chọn có hiệu lực khi lưu.</small></span></label></section>
        <button type="submit" className="settings-wide-save" disabled={!dirty || saving || busy || waitingForGoogle || Boolean(loadError)}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Lưu thiết lập Drive</button>
      </form>
      <section className="settings-card drive-account-card"><div className="settings-section-title"><Cloud size={21} /><div><h3>Tài khoản Google Drive</h3><p>{status.connected ? 'Đã cấp quyền cho thư mục Drive do Luma quản lý.' : 'Trình duyệt hệ thống sẽ mở để bạn đăng nhập và cấp quyền.'}</p></div><span className={`connection-pill ${status.connected ? 'connected' : ''}`}>{status.connected ? 'Đã kết nối' : 'Chưa kết nối'}</span></div><div className="drive-account-actions">{status.connected ? <button type="button" className="subtle-button" disabled={busy || saving || disconnecting || waitingForGoogle} onClick={() => void disconnect()}>{disconnecting ? <LoaderCircle size={14} className="spin" /> : <LogOut size={14} />} Ngắt kết nối</button> : <button type="button" className="drive-connect-button" disabled={!hasConfiguration || dirty || saving || waitingForGoogle || Boolean(loadError)} onClick={() => void connect()}>{waitingForGoogle ? <LoaderCircle size={16} className="spin" /> : <Cloud size={16} />}{waitingForGoogle ? 'Chờ bạn đăng nhập ở trình duyệt…' : 'Kết nối Google'}</button>}{waitingForGoogle && <button type="button" className="text-button" onClick={() => void cancelConnect()}><X size={13} /> Hủy đăng nhập</button>}<button type="button" className="settings-inline-navigation" onClick={onNavigateLinks}>Thiết lập OAuth <ArrowRight size={13} /></button></div>{dirty && <p className="settings-help">Lưu các thay đổi trước khi kết nối hoặc bắt đầu đồng bộ.</p>}</section>
      <section className="settings-card drive-sync-card"><div className="settings-section-title"><CloudUpload size={21} /><div><h3>Trạng thái đồng bộ</h3><p>{status.config.autoSync && status.connected ? 'Tự động đồng bộ đang bật khi Luma chạy.' : 'Có thể đồng bộ ngay sau khi kết nối và lưu thư mục nguồn.'}</p></div></div><div className="drive-sync-message" role={status.phase === 'error' ? 'alert' : 'status'}>{busy || waitingForGoogle ? <LoaderCircle size={17} className="spin" /> : status.phase === 'error' ? <AlertCircle size={17} /> : <Check size={17} />}<span>{status.message || (status.connected ? 'Sẵn sàng đồng bộ FLAC, MP3, M4A.' : 'Chưa kết nối Google Drive.')}</span></div><div className={`drive-progress ${status.phase === 'scanning' ? 'scanning' : ''}`} role="progressbar" aria-label="Tiến trình đồng bộ Google Drive" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.phase === 'scanning' ? undefined : Math.round(progress)}><i style={{ width: `${progress}%` }} /></div><div className="drive-progress-caption"><span>{status.filesDone} / {status.filesTotal} file</span><span>{bytes(status.bytesUploaded)} / {bytes(status.bytesTotal)} · {Math.round(progress)}%</span></div><div className="drive-statistics"><div><strong>{status.uploaded}</strong><span>Đã tải lên</span></div><div><strong>{status.skipped}</strong><span>Đã có · bỏ qua</span></div><div className={status.failed ? 'has-errors' : ''}><strong>{status.failed}</strong><span>Có lỗi</span></div></div><div className="drive-last-sync"><span>Lần đồng bộ gần nhất</span><strong>{syncDate(status.lastSyncAt)}</strong></div><div className="drive-sync-actions"><button type="button" className="primary-button" disabled={!status.connected || !status.config.sourceDirectory || dirty || saving || busy || waitingForGoogle} onClick={() => void syncNow()}>{busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} Đồng bộ ngay</button>{busy && <button type="button" className="subtle-button" disabled={cancelling} onClick={() => void cancelSync()}>{cancelling ? <LoaderCircle size={14} className="spin" /> : <X size={14} />} Dừng đồng bộ</button>}</div></section>
    </>}
  </div>;
}
