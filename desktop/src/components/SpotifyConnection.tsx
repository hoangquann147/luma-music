import { useRef, useState } from 'react';
import { ArrowRight, Check, Copy, LoaderCircle, LogOut, X } from 'lucide-react';
import type { SpotifyAuthStatus } from '../../shared/types';
import SpotifyLogo from './SpotifyLogo';

export default function SpotifyConnection({ auth, clientId, onAuth, fail, success, requireDesktop, onNavigateLinks }: {
  auth: SpotifyAuthStatus; clientId: string; onAuth: (auth: SpotifyAuthStatus) => void;
  fail: (message: string) => void; success: (message: string) => void; requireDesktop: () => boolean;
  onNavigateLinks: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const request = useRef(0);
  const connect = async () => {
    if (!requireDesktop()) return;
    const generation = ++request.current;
    setConnecting(true);
    try {
      const status = await window.music!.connectSpotify();
      if (generation === request.current) { onAuth(status); success('Đã kết nối Spotify. Bạn có thể nhập playlist được cấp quyền.'); }
    } catch (error) { if (generation === request.current) fail(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === request.current) setConnecting(false); }
  };
  const cancel = async () => {
    if (!requireDesktop()) return;
    ++request.current;
    try { await window.music!.cancelSpotifyConnect(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setConnecting(false); }
  };
  const disconnect = async () => {
    if (!requireDesktop()) return;
    setDisconnecting(true);
    try { onAuth(await window.music!.disconnectSpotify()); success('Đã ngắt kết nối Spotify trên ứng dụng này.'); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setDisconnecting(false); }
  };
  const copyRedirect = async () => {
    try { await navigator.clipboard.writeText(auth.redirectUri || 'http://127.0.0.1:43827/callback'); success('Đã sao chép Redirect URI.'); }
    catch { fail('Không sao chép được. Chọn và sao chép Redirect URI hiển thị bên dưới.'); }
  };
  return <section className="settings-card spotify-connection">
    <div className="settings-section-title"><span className="spotify-brand"><SpotifyLogo size={22} /></span><div><h3>Kết nối Spotify để nhập playlist</h3><p>Đăng nhập bằng trình duyệt để đọc playlist công khai và riêng tư trong phạm vi được cấp quyền.</p></div><span className={`connection-pill ${auth.connected ? 'connected' : ''}`}>{auth.connected ? 'Đã kết nối' : 'Chưa kết nối'}</span></div>
    {auth.connected ? <div className="spotify-account"><span className="account-check"><Check size={16} /></span><div><strong>{auth.displayName || 'Tài khoản Spotify đã kết nối'}</strong><small>Quyền truy cập chỉ dành cho metadata playlist.</small></div><button className="subtle-button" type="button" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? <LoaderCircle size={14} className="spin" /> : <LogOut size={14} />} Ngắt kết nối</button></div> : <>
      <ol className="oauth-steps"><li>Lưu <strong>Client ID</strong> của ứng dụng Spotify ở phần metadata bên dưới.</li><li>Đăng ký Redirect URI sau trong Spotify Developer Dashboard một lần:</li></ol>
      <div className="redirect-field"><code>{auth.redirectUri || 'http://127.0.0.1:43827/callback'}</code><button className="icon-button" type="button" aria-label="Sao chép Spotify Redirect URI" onClick={() => void copyRedirect()}><Copy size={15} /></button></div>
      <div className="spotify-connect-actions"><button className="spotify-connect-button" type="button" disabled={!clientId.trim() || connecting} onClick={() => void connect()}>{connecting ? <LoaderCircle size={16} className="spin" /> : <SpotifyLogo size={17} />}{connecting ? 'Chờ bạn đăng nhập ở trình duyệt…' : 'Connect Spotify'}</button>{connecting ? <button className="text-button" type="button" onClick={() => void cancel()}><X size={13} /> Hủy kết nối</button> : <button className="text-button" type="button" onClick={onNavigateLinks}>Mở mục Liên kết <ArrowRight size={12} /></button>}</div>
      {!clientId.trim() && <p className="settings-help">Điền và lưu Client ID trước khi kết nối.</p>}
    </>}
    <p className="settings-help">Đăng nhập playlist dùng OAuth PKCE: không cần Client Secret. Bạn tự đăng nhập và duyệt quyền trong trình duyệt; Luma không nhận mật khẩu Spotify.</p>
  </section>;
}
