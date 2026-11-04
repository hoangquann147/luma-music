package app.luma.music;

import android.content.Context;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.util.AtomicFile;
import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

/** Audio lives in private offline storage. Only a validated complete file enters the index. */
public final class LibraryRepository {
    public static final class Track {
        public String id,title,artist,album,path,remoteId,md5;
        public long durationMs;
        Track(JSONObject j) { id=j.optString("id"); title=j.optString("title","Unknown"); artist=j.optString("artist","Unknown artist"); album=j.optString("album"); path=j.optString("path"); remoteId=j.optString("remoteId"); md5=j.optString("md5"); durationMs=j.optLong("durationMs"); }
        JSONObject json() throws JSONException { return new JSONObject().put("id",id).put("title",title).put("artist",artist).put("album",album).put("path",path).put("remoteId",remoteId).put("md5",md5).put("durationMs",durationMs); }
    }
    public static final class PreparedDownload {
        final File temporary,destination;
        final Track track;
        PreparedDownload(File temporary,File destination,Track track){this.temporary=temporary;this.destination=destination;this.track=track;}
    }
    private static LibraryRepository instance;
    public static synchronized LibraryRepository get(Context context) { if(instance==null) instance=new LibraryRepository(context.getApplicationContext()); return instance; }
    private final Context context;
    private final File directory;
    private final AtomicFile index;
    private final LinkedHashMap<String,Track> tracks=new LinkedHashMap<>();
    private String loadError;
    private LibraryRepository(Context context) {
        this.context=context; directory=new File(context.getFilesDir(),"music"); directory.mkdirs(); index=new AtomicFile(new File(context.getFilesDir(),"library.json"));
        try(InputStream in=index.openRead()) {
            ByteArrayOutputStream bytes=new ByteArrayOutputStream(); byte[] buffer=new byte[8192]; int n;
            while((n=in.read(buffer))!=-1) { if(bytes.size()+n>16*1024*1024) throw new IOException("Thư viện vượt giới hạn metadata."); bytes.write(buffer,0,n); }
            JSONObject data=new JSONObject(bytes.toString("UTF-8"));
            JSONArray array=data.getJSONArray("tracks");
            for(int i=0;i<array.length();i++) { Track track=new Track(array.getJSONObject(i)); if(owned(new File(track.path))) tracks.put(track.id,track); }
        } catch(FileNotFoundException error) { if(index.getBaseFile().exists() || new File(index.getBaseFile()+".bak").exists()) loadError="Không mở được thư viện; dữ liệu gốc được giữ."; }
        catch(Exception error) { loadError="Không đọc được thư viện; dữ liệu gốc được giữ. "+error.getMessage(); }
    }
    private boolean owned(File file) { try { return file.getCanonicalPath().startsWith(directory.getCanonicalPath()+File.separator); } catch(IOException e) { return false; } }
    public File musicDirectory() { return directory; }
    public synchronized List<Track> list() { return new ArrayList<>(tracks.values()); }
    public synchronized Track get(String id) { return tracks.get(id); }
    public synchronized Track findRemote(String remoteId) { for(Track t:tracks.values()) if(t.remoteId.equals(remoteId)) return t; return null; }
    private synchronized void save() throws Exception {
        if(loadError!=null) throw new IOException(loadError);
        JSONArray array=new JSONArray(); for(Track track:tracks.values()) array.put(track.json());
        FileOutputStream output=index.startWrite();
        try { output.write(new JSONObject().put("version",1).put("tracks",array).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); index.finishWrite(output); }
        catch(Exception e) { index.failWrite(output); throw e; }
    }
    public Track importUri(Uri uri) throws Exception {
        File temporary=File.createTempFile("import-",".part",directory);
        try {
            try(InputStream in=context.getContentResolver().openInputStream(uri); OutputStream out=new FileOutputStream(temporary)) {
                if(in==null) throw new IOException("Không mở được file đã chọn."); byte[] buffer=new byte[128*1024]; int n; long total=0;
                while((n=in.read(buffer))!=-1) { total+=n; if(total>SyncRules.MAX_FILE_BYTES) throw new IOException("Mỗi file tối đa 2 GB."); if(directory.getUsableSpace()<8L*1024*1024) throw new IOException("Điện thoại không đủ dung lượng."); out.write(buffer,0,n); }
            }
            SyncRules.verifyFlac(temporary,null,-1);
            String md5=SyncRules.md5(temporary), id="local-"+md5;
            synchronized(this) { if(tracks.containsKey(id) && new File(tracks.get(id).path).isFile()) return tracks.get(id); }
            String name=uri.getLastPathSegment(); if(name==null) name="FLAC";
            return publish(temporary,new File(directory,id+".flac"),id,"",md5,name,null);
        } finally { temporary.delete(); }
    }
    public Track publishDownload(File temporary, JSONObject remote) throws Exception {
        SyncRules.verifyFlac(temporary,remote.getString("md5Checksum"),Long.parseLong(remote.getString("size")));
        return publishPreparedDownload(prepareVerifiedDownload(temporary,remote));
    }
    /** Caller has checked MD5; expensive metadata work occurs before its final session/version guard. */
    public PreparedDownload prepareVerifiedDownload(File temporary,JSONObject remote) throws Exception {
        String id=remote.getString("id"),md5=remote.getString("md5Checksum");
        SyncRules.verifyFlac(temporary,null,Long.parseLong(remote.getString("size")));
        File destination=new File(directory,SyncRules.localName(id,md5));
        return new PreparedDownload(temporary,destination,prepareTrack(temporary,destination,"drive-"+SyncRules.sha256(id),id,md5,remote.optString("name","FLAC"),remote.optJSONObject("properties")));
    }
    public Track publishPreparedDownload(PreparedDownload prepared) throws Exception { return commit(prepared.temporary,prepared.destination,prepared.track); }
    private Track publish(File temporary,File destination,String id,String remoteId,String md5,String fallback,JSONObject properties) throws Exception {
        return commit(temporary,destination,prepareTrack(temporary,destination,id,remoteId,md5,fallback,properties));
    }
    private Track prepareTrack(File temporary,File destination,String id,String remoteId,String md5,String fallback,JSONObject properties) throws Exception {
        JSONObject json=new JSONObject().put("id",id).put("path",destination.getAbsolutePath()).put("remoteId",remoteId).put("md5",md5);
        MediaMetadataRetriever retriever=new MediaMetadataRetriever();
        try {
            retriever.setDataSource(temporary.getAbsolutePath());
            String title=retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE);
            String artist=retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST);
            String album=retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM);
            String duration=retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            json.put("title",title!=null?title:properties!=null?properties.optString("title",fallback):fallback.replaceFirst("(?i)\\.flac$",""));
            json.put("artist",artist!=null?artist:properties!=null?properties.optString("artist","Unknown artist"):"Unknown artist");
            json.put("album",album!=null?album:properties!=null?properties.optString("album",""):"");
            json.put("durationMs",duration!=null?Long.parseLong(duration):0);
        } finally { retriever.release(); }
        return new Track(json);
    }
    private Track commit(File temporary,File destination,Track track) throws Exception {
        Track old;
        synchronized(this) {
            if(loadError!=null) throw new IOException(loadError);
            old=tracks.get(track.id);
            Files.move(temporary.toPath(),destination.toPath(),StandardCopyOption.REPLACE_EXISTING);
            tracks.put(track.id,track);
            try { save(); } catch(Exception e) { if(old!=null) tracks.put(track.id,old); else tracks.remove(track.id); throw e; }
        }
        if(old!=null && !old.path.equals(track.path) && owned(new File(old.path))) new File(old.path).delete();
        return track;
    }
    public synchronized void remove(String id) throws Exception {
        Track old=tracks.remove(id); if(old==null) return;
        try { save(); } catch(Exception e) { tracks.put(id,old); throw e; }
        if(owned(new File(old.path))) new File(old.path).delete();
    }
}
