using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Luma")]
[assembly: AssemblyProduct("Luma")]
[assembly: AssemblyCompany("Luma contributors")]
[assembly: AssemblyDescription("Luma portable desktop music player")]
[assembly: AssemblyVersion("1.5.0.0")]
[assembly: AssemblyFileVersion("1.5.0.0")]

internal static class PortableLauncher
{
    private const string Version = "1.5.0";
    private const string Prefix = "Luma-" + Version + "-";
    private const string Marker = ".luma-portable-owner";

    [STAThread]
    private static int Main(string[] args)
    {
        bool verify = args.Length > 0 && (args[0] == "--verify-package" || args[0] == "--verify-only");
        string root = null;
        string owned = null;
        string token = Guid.NewGuid().ToString("N");
        string reportPath = null;
        var values = new SortedDictionary<string, string>(StringComparer.Ordinal);
        int result = 1;
        try
        {
            if ((!verify && args.Length != 0) || (verify && args.Length > 2))
                throw new ArgumentException("Usage: Luma.exe [--verify-package [absolute-scratch-directory]]");
            if (verify && args.Length == 2 && !Path.IsPathRooted(args[1])) throw new ArgumentException("Scratch directory must be absolute.");
            root = Path.GetFullPath(verify && args.Length == 2 ? args[1] : Path.GetTempPath());
            Directory.CreateDirectory(root);
            owned = Path.Combine(root, Prefix + token);
            if (Directory.Exists(owned) || File.Exists(owned)) throw new IOException("Temporary directory already exists.");
            Directory.CreateDirectory(owned);
            File.WriteAllText(Path.Combine(owned, Marker), token, new UTF8Encoding(false));
            string launcherFiles = Path.Combine(owned, "launcher");
            string extracted = Path.Combine(owned, "app");
            Directory.CreateDirectory(launcherFiles);
            Directory.CreateDirectory(extracted);
            string archive = Path.Combine(launcherFiles, "payload.7z");
            string extractor = Path.Combine(launcherFiles, "7za.exe");
            CopyResource("Luma.Payload.7z", archive);
            CopyResource("Luma.SevenZip.exe", extractor);
            CopyResource("Luma.SevenZip.LICENSE.txt", Path.Combine(launcherFiles, "7zip-LICENSE.txt"));
            CopyResource("Luma.SevenZip.COPYING", Path.Combine(launcherFiles, "7zip-COPYING.txt"));
            var manifest = ReadManifest();
            string payloadHash = Hash(archive);
            string extractorHash = Hash(extractor);
            if (!manifest.ContainsKey("PayloadSha256") || !String.Equals(manifest["PayloadSha256"], payloadHash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Embedded application archive failed its SHA-256 check.");
            if (!manifest.ContainsKey("SevenZipSha256") || !String.Equals(manifest["SevenZipSha256"], extractorHash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Embedded extractor failed its SHA-256 check.");
            values["version"] = Version;
            values["payloadSha256"] = payloadHash;
            values["extractorSha256"] = extractorHash;
            values["extractionDirectory"] = extracted;
            Extract(extractor, archive, extracted);
            string app = Path.Combine(extracted, "Luma.exe");
            var required = new string[] {
                "Luma.exe", "resources\\app.asar", "resources\\THIRD-PARTY-NOTICES.md",
                "resources\\tools\\ffmpeg.exe", "resources\\tools\\ffprobe.exe",
                "resources\\tools\\yt-dlp.exe", "resources\\tools\\deno.exe",
                "resources\\tools\\avcodec-63.dll", "resources\\tools\\avdevice-63.dll",
                "resources\\tools\\avfilter-12.dll", "resources\\tools\\avformat-63.dll",
                "resources\\tools\\avutil-61.dll", "resources\\tools\\swresample-7.dll",
                "resources\\tools\\swscale-10.dll", "resources\\tools\\THIRD-PARTY-NOTICES.md"
            };
            foreach (string relative in required)
            {
                string file = Path.Combine(extracted, relative);
                if (!File.Exists(file) || new FileInfo(file).Length == 0) throw new InvalidDataException("Missing packaged file: " + relative);
                if (verify) values["sha256:" + relative] = Hash(file);
            }
            FileVersionInfo version = FileVersionInfo.GetVersionInfo(app);
            if (version.ProductName != "Luma" || version.FileVersion == null || !version.FileVersion.StartsWith(Version, StringComparison.Ordinal))
                throw new InvalidDataException("The embedded application has unexpected product metadata.");
            values["productName"] = version.ProductName;
            values["fileVersion"] = version.FileVersion;
            values["verifiedFileCount"] = required.Length.ToString();
            values["electronLaunched"] = "false";
            if (verify)
            {
                result = 0;
                values["status"] = "verified";
            }
            else
            {
                var start = new ProcessStartInfo(app);
                start.WorkingDirectory = extracted;
                start.UseShellExecute = true;
                using (Process application = Process.Start(start))
                {
                    if (application == null) throw new IOException("Windows could not start Luma.");
                    application.WaitForExit();
                    result = application.ExitCode;
                }
            }
        }
        catch (Exception error)
        {
            values["status"] = "error";
            values["error"] = error.Message;
            if (verify) Console.Error.WriteLine("Luma verification failed: " + error.Message);
            else MessageBox.Show("Khong the mo Luma.\r\n\r\n" + error.Message, "Luma", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            bool cleaned = owned == null || Cleanup(root, owned, token);
            values["temporaryFilesCleaned"] = cleaned ? "true" : "false";
            if (verify && root != null)
            {
                try
                {
                    reportPath = Path.Combine(root, "Luma-verification-" + token + ".json");
                    using (var output = new FileStream(reportPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                    using (var writer = new StreamWriter(output, new UTF8Encoding(false))) writer.Write(Json(values));
                    Console.WriteLine(Json(values));
                    Console.WriteLine("Report: " + reportPath);
                }
                catch (Exception error) { Console.Error.WriteLine(error.Message); result = 1; }
            }
        }
        return result;
    }

    private static void CopyResource(string name, string target)
    {
        using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (input == null) throw new InvalidDataException("Missing embedded resource: " + name);
            using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, FileOptions.SequentialScan))
                input.CopyTo(output, 1024 * 1024);
        }
    }

    private static Dictionary<string, string> ReadManifest()
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("Luma.PackageManifest"))
        {
            if (input == null) throw new InvalidDataException("Package manifest is missing.");
            using (var reader = new StreamReader(input, Encoding.UTF8))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    int separator = line.IndexOf('=');
                    if (separator > 0) result[line.Substring(0, separator)] = line.Substring(separator + 1).Trim();
                }
            }
        }
        return result;
    }

    private static string Hash(string file)
    {
        using (var sha = SHA256.Create())
        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.SequentialScan))
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static string Quote(string argument)
    {
        // Windows CommandLineToArgvW quoting, including trailing backslashes.
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char value in argument)
        {
            if (value == '\\') { slashes++; continue; }
            if (value == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(value);
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }

    private static void Extract(string extractor, string archive, string destination)
    {
        var start = new ProcessStartInfo(extractor);
        start.Arguments = "x -y -bd -bb0 " + Quote(archive) + " " + Quote("-o" + destination);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.WindowStyle = ProcessWindowStyle.Hidden;
        start.WorkingDirectory = Path.GetDirectoryName(extractor);
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        var diagnostic = new StringBuilder();
        using (var process = new Process())
        {
            process.StartInfo = start;
            DataReceivedEventHandler collect = delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data == null) return;
                lock (diagnostic) { if (diagnostic.Length < 8000) diagnostic.AppendLine(args.Data); }
            };
            process.OutputDataReceived += collect;
            process.ErrorDataReceived += collect;
            if (!process.Start()) throw new IOException("Cannot start the embedded archive extractor.");
            process.BeginOutputReadLine(); process.BeginErrorReadLine();
            if (!process.WaitForExit(10 * 60 * 1000))
            {
                process.Kill(); process.WaitForExit();
                throw new IOException("Archive extraction exceeded ten minutes.");
            }
            process.WaitForExit();
            if (process.ExitCode != 0) throw new IOException("Archive extraction failed (" + process.ExitCode + "). " + diagnostic.ToString());
        }
    }

    private static bool Cleanup(string root, string owned, string token)
    {
        try
        {
            if (root == null || !Directory.Exists(owned)) return true;
            string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string fullOwned = Path.GetFullPath(owned);
            if (!fullOwned.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase) || Path.GetFileName(fullOwned) != Prefix + token) return false;
            if ((File.GetAttributes(fullOwned) & FileAttributes.ReparsePoint) != 0) return false;
            if (File.ReadAllText(Path.Combine(fullOwned, Marker)) != token) return false;
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try { DeleteOwnedTree(fullOwned); return true; }
                catch (IOException) { Thread.Sleep(250); }
                catch (UnauthorizedAccessException) { Thread.Sleep(250); }
            }
        }
        catch { }
        return false;
    }

    private static void DeleteOwnedTree(string directory)
    {
        foreach (string file in Directory.GetFiles(directory)) File.Delete(file);
        foreach (string child in Directory.GetDirectories(directory))
        {
            if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0) Directory.Delete(child, false);
            else DeleteOwnedTree(child);
        }
        Directory.Delete(directory, false);
    }

    private static string Escape(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t");
    }

    private static string Json(SortedDictionary<string, string> values)
    {
        var result = new StringBuilder("{\n");
        int count = 0;
        foreach (var pair in values)
        {
            if (count++ != 0) result.Append(",\n");
            result.Append("  \"").Append(Escape(pair.Key)).Append("\": \"").Append(Escape(pair.Value)).Append("\"");
        }
        return result.Append("\n}\n").ToString();
    }
}
