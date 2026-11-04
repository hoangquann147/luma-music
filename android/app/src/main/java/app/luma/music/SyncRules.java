package app.luma.music;

import java.io.*;
import java.security.MessageDigest;
import java.util.Locale;

/** Pure Java rules shared by import and Drive sync; no Android or network state. */
public final class SyncRules {
    public static final long MAX_FILE_BYTES = 2L * 1024 * 1024 * 1024;
    private SyncRules() {}
    public static boolean validDriveId(String id) { return id != null && id.matches("[A-Za-z0-9_-]{5,200}"); }
    public static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(Locale.ROOT,"%02x", b & 255)); return out.toString(); }
    public static String sha256(String value) { try { return hex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8))); } catch(Exception e) { throw new IllegalStateException(e); } }
    public static String md5(File file) throws IOException {
        try { MessageDigest digest=MessageDigest.getInstance("MD5"); try(InputStream in=new FileInputStream(file)) { byte[] b=new byte[128*1024]; int n; while((n=in.read(b))!=-1) digest.update(b,0,n); } return hex(digest.digest()); }
        catch(java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    public static void verifyFlac(File file, String expectedMd5, long expectedSize) throws IOException {
        if (file.length()<4 || file.length()>MAX_FILE_BYTES || (expectedSize>=0 && file.length()!=expectedSize)) throw new IOException("Kích thước file FLAC không khớp.");
        try(InputStream in=new FileInputStream(file)) { byte[] header=new byte[4]; if(in.read(header)!=4 || header[0]!='f' || header[1]!='L' || header[2]!='a' || header[3]!='C') throw new IOException("File không có định dạng FLAC hợp lệ."); }
        if(expectedMd5!=null && !expectedMd5.isEmpty() && (!expectedMd5.matches("[a-fA-F0-9]{32}") || !md5(file).equalsIgnoreCase(expectedMd5))) throw new IOException("Checksum không khớp. Bản tải chưa được thêm vào thư viện.");
    }
    public static String localName(String remoteId, String md5) {
        if(!validDriveId(remoteId) || md5==null || !md5.matches("[a-fA-F0-9]{32}")) throw new IllegalArgumentException("Metadata Drive không hợp lệ.");
        return "drive-"+sha256(remoteId)+"-"+md5.toLowerCase(Locale.ROOT)+".flac";
    }
}
