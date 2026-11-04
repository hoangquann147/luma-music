package app.luma.music;
import org.junit.Test;
import java.io.*;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class SyncRulesTest {
    @Test public void downloadNamesCannotEscapePrivateStorage() {
        assertFalse(SyncRules.validDriveId("../../music.flac"));
        assertFalse(SyncRules.validDriveId("id?alt=media&other=1"));
        String name=SyncRules.localName("Remote_id-123", "e2fc714c4727ee9395f324cd2e7f331f");
        assertTrue(name.matches("drive-[a-f0-9]{64}-[a-f0-9]{32}\\.flac"));
        assertEquals(name,SyncRules.localName("Remote_id-123", "E2FC714C4727EE9395F324CD2E7F331F"));
    }
    @Test public void incompleteOrChangedDownloadsNeverPassValidation() throws Exception {
        File file=File.createTempFile("luma-", ".part");
        try {
            Files.write(file.toPath(),new byte[]{'f','L','a','C',0,1,2,3});
            String checksum=SyncRules.md5(file); SyncRules.verifyFlac(file,checksum,8);
            assertThrows(IOException.class,()->SyncRules.verifyFlac(file,checksum,9));
            assertThrows(IOException.class,()->SyncRules.verifyFlac(file,"00000000000000000000000000000000",8));
            Files.write(file.toPath(),new byte[]{'I','D','3',0,1,2,3,4});
            assertThrows(IOException.class,()->SyncRules.verifyFlac(file,null,8));
        } finally { file.delete(); }
    }
    @Test public void contentHashMatchesKnownBytes() throws Exception {
        File file=File.createTempFile("luma-md5-", ".flac");
        try { Files.write(file.toPath(),new byte[]{'a','b','c','d'}); assertEquals("e2fc714c4727ee9395f324cd2e7f331f",SyncRules.md5(file)); }
        finally { file.delete(); }
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",SyncRules.sha256("abc"));
    }
}
