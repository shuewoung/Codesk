using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class CodeskHub
{
    const int Port = 18990;
    const string AppUrl = "http://127.0.0.1:18990/";
    const string HostUrl = "http://127.0.0.1:18990/host";
    const string MutexName = "Global\\CodeskHubTray";

    static Process hubProc;
    static volatile bool exiting;

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    static void EnableDpiAwareness()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
        }
        catch { }
        try { SetProcessDPIAware(); }
        catch { }
    }

    [STAThread]
    static void Main()
    {
        EnableDpiAwareness();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool created;
        using (var mutex = new Mutex(true, MutexName, out created))
        {
            if (!created)
            {
                OpenUrl(HostUrl);
                return;
            }
            try
            {
                var hubDir = FindHubDir();
                if (hubDir == null)
                {
                    MessageBox.Show("安装不完整：找不到 hub 目录。请重新运行安装包。", "Codesk");
                    return;
                }
                if (!HubUp()) StartHub(hubDir);
                for (var i = 0; i < 40 && !HubUp(); i++) Thread.Sleep(250);
                if (!HubUp())
                {
                    MessageBox.Show("Hub 没有起来。", "Codesk");
                    return;
                }
                Application.Run(new TrayApp());
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "Codesk");
            }
            finally
            {
                StopHub();
            }
        }
    }

    static string ExeDir()
    {
        return Path.GetDirectoryName(Application.ExecutablePath) ?? "";
    }

    static string FindHubDir()
    {
        foreach (var guess in new[]
        {
            Path.Combine(ExeDir(), "hub"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Codesk", "hub"),
            Path.GetFullPath(Path.Combine(ExeDir(), "..", "apps", "web-hub")),
        })
        {
            if (Directory.Exists(Path.Combine(guess, "server"))) return guess;
        }
        return null;
    }

    static bool HubUp()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + "/api/auth/status");
            req.Timeout = 800;
            using (var resp = req.GetResponse()) return true;
        }
        catch
        {
            return false;
        }
    }

    static string HttpGet(string url)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Timeout = 2000;
        using (var resp = (HttpWebResponse)req.GetResponse())
        using (var sr = new StreamReader(resp.GetResponseStream()))
            return sr.ReadToEnd();
    }

    static void StartHub(string hubDir)
    {
        var node = FindNode();
        if (node == null) throw new Exception("安装不完整：找不到 node.exe。请重新运行安装包。");
        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "server/index.js",
            WorkingDirectory = hubDir,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ONEDESK_RELAY_URL"))
            && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("CODESK_RELAY_URL")))
        {
            psi.EnvironmentVariables["ONEDESK_RELAY_URL"] = "http://hub.codesk.icu:8787";
        }
        hubProc = Process.Start(psi);
        if (hubProc != null) hubProc.EnableRaisingEvents = true;
    }

    static void StopHub()
    {
        try
        {
            if (hubProc != null && !hubProc.HasExited) hubProc.Kill();
        }
        catch { }
    }

    static string FindNode()
    {
        foreach (var exe in new[]
        {
            Path.Combine(ExeDir(), "node", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Codesk", "node", "node.exe"),
        })
        {
            try
            {
                var full = Path.GetFullPath(exe);
                if (File.Exists(full)) return full;
            }
            catch { }
        }
        return null;
    }

    static void OpenUrl(string url)
    {
        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
    }

    static Bitmap LoadBrandBitmap()
    {
        var hub = FindHubDir();
        foreach (var path in new[]
        {
            hub == null ? null : Path.Combine(hub, "public", "favicon-192.png"),
            hub == null ? null : Path.Combine(hub, "public", "icons", "codesk-app.png"),
            hub == null ? null : Path.Combine(hub, "public", "icons", "icon-32.png"),
            Path.Combine(ExeDir(), "hub", "public", "favicon-192.png"),
            Path.Combine(ExeDir(), "favicon-192.png"),
        })
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) continue;
            try
            {
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var img = Image.FromStream(fs))
                    return new Bitmap(img);
            }
            catch { }
        }
        return null;
    }

    static Icon CreateIcon(Bitmap src, int size)
    {
        using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingQuality = CompositingQuality.HighQuality;
                int pad = size >= 24 ? 2 : 1;
                g.DrawImage(src, pad, pad, size - pad * 2, size - pad * 2);
            }
            using (var ms = new MemoryStream())
            {
                WriteBmpIco(ms, bmp);
                ms.Position = 0;
                using (var tmp = new Icon(ms))
                    return new Icon(tmp, size, size);
            }
        }
    }

    static void WriteBmpIco(Stream stream, Bitmap bmp)
    {
        int s = bmp.Width;
        int xorSize = s * s * 4;
        int andRow = ((s + 31) / 32) * 4;
        int andSize = andRow * s;
        int dibLen = 40 + xorSize + andSize;
        var bw = new BinaryWriter(stream);
        bw.Write((short)0);
        bw.Write((short)1);
        bw.Write((short)1);
        bw.Write((byte)(s >= 256 ? 0 : s));
        bw.Write((byte)(s >= 256 ? 0 : s));
        bw.Write((byte)0);
        bw.Write((byte)0);
        bw.Write((short)1);
        bw.Write((short)32);
        bw.Write(dibLen);
        bw.Write(22);
        bw.Write(40);
        bw.Write(s);
        bw.Write(s * 2);
        bw.Write((short)1);
        bw.Write((short)32);
        bw.Write(0);
        bw.Write(xorSize);
        bw.Write(0);
        bw.Write(0);
        bw.Write(0);
        bw.Write(0);
        var rect = new Rectangle(0, 0, s, s);
        var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int stride = data.Stride;
            var row = new byte[s * 4];
            for (int y = s - 1; y >= 0; y--)
            {
                Marshal.Copy(IntPtr.Add(data.Scan0, y * stride), row, 0, s * 4);
                bw.Write(row);
            }
        }
        finally
        {
            bmp.UnlockBits(data);
        }
        bw.Write(new byte[andSize]);
        bw.Flush();
    }

    static Icon LoadAppIcon()
    {
        using (var bmp = LoadBrandBitmap())
        {
            if (bmp != null)
            {
                try { return CreateIcon(bmp, 16); }
                catch { }
            }
        }
        try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch { }
        return SystemIcons.Application;
    }

    static Font MenuFont(FontStyle style)
    {
        foreach (var name in new[] { "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI" })
        {
            try
            {
                return new Font(name, 9f, style, GraphicsUnit.Point);
            }
            catch { }
        }
        return new Font(SystemFonts.MenuFont, style);
    }

    static string StartupShortcut()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Codesk Hub.lnk");
    }

    static bool AutoStartOn()
    {
        return File.Exists(StartupShortcut());
    }

    static void SetAutoStart(bool on)
    {
        var link = StartupShortcut();
        if (on)
        {
            var t = Type.GetTypeFromProgID("WScript.Shell");
            var shell = Activator.CreateInstance(t);
            var sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { link });
            var scType = sc.GetType();
            scType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { Application.ExecutablePath });
            scType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { ExeDir() });
            scType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { Application.ExecutablePath + ",0" });
            scType.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
        }
        else if (File.Exists(link))
        {
            File.Delete(link);
        }
    }

    static int ReadRemoteCount(string json)
    {
        if (string.IsNullOrEmpty(json)) return 0;
        var key = "\"remoteCount\":";
        var i = json.IndexOf(key, StringComparison.Ordinal);
        if (i < 0) return 0;
        i += key.Length;
        var n = 0;
        while (i < json.Length && json[i] >= '0' && json[i] <= '9')
        {
            n = n * 10 + (json[i] - '0');
            i++;
        }
        return n;
    }

    sealed class CodeskColorTable : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground { get { return Color.White; } }
        public override Color ImageMarginGradientBegin { get { return Color.White; } }
        public override Color ImageMarginGradientMiddle { get { return Color.White; } }
        public override Color ImageMarginGradientEnd { get { return Color.White; } }
        public override Color MenuBorder { get { return Color.FromArgb(230, 232, 238); } }
        public override Color MenuItemBorder { get { return Color.Transparent; } }
        public override Color MenuItemSelected { get { return Color.FromArgb(245, 247, 255); } }
        public override Color MenuItemSelectedGradientBegin { get { return Color.FromArgb(245, 247, 255); } }
        public override Color MenuItemSelectedGradientEnd { get { return Color.FromArgb(245, 247, 255); } }
        public override Color MenuItemPressedGradientBegin { get { return Color.FromArgb(232, 236, 255); } }
        public override Color MenuItemPressedGradientEnd { get { return Color.FromArgb(232, 236, 255); } }
        public override Color SeparatorDark { get { return Color.FromArgb(230, 232, 238); } }
        public override Color SeparatorLight { get { return Color.FromArgb(230, 232, 238); } }
        public override Color CheckBackground { get { return Color.White; } }
        public override Color CheckSelectedBackground { get { return Color.FromArgb(245, 247, 255); } }
        public override Color CheckPressedBackground { get { return Color.FromArgb(232, 236, 255); } }
    }

    sealed class CodeskMenuRenderer : ToolStripProfessionalRenderer
    {
        public CodeskMenuRenderer() : base(new CodeskColorTable())
        {
            RoundedEdges = false;
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            var r = new Rectangle(0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
            using (var pen = new Pen(Color.FromArgb(230, 232, 238)))
                e.Graphics.DrawRectangle(pen, r);
        }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            var tag = e.Item.Tag as string;
            if (tag == "header" || tag == "status" || !e.Item.Selected || !e.Item.Enabled)
                return;
            var r = new Rectangle(6, 1, e.Item.Width - 12, e.Item.Height - 2);
            if (r.Width < 8 || r.Height < 8) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = RoundRect(r, 6))
            using (var b = new SolidBrush(Color.FromArgb(245, 247, 255)))
                e.Graphics.FillPath(b, path);
            e.Graphics.SmoothingMode = SmoothingMode.None;
            e.Graphics.PixelOffsetMode = PixelOffsetMode.None;
            e.Graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            if (string.IsNullOrEmpty(e.Text)) return;
            var tag = e.Item.Tag as string;
            Color color;
            if (tag == "header") color = Color.FromArgb(18, 20, 26);
            else if (tag == "status") color = Color.FromArgb(92, 99, 112);
            else if (e.Item.Text == "退出")
                color = e.Item.Selected ? Color.FromArgb(196, 60, 60) : Color.FromArgb(92, 99, 112);
            else color = Color.FromArgb(18, 20, 26);
            var flags = TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.HidePrefix | TextFormatFlags.NoPadding | TextFormatFlags.PreserveGraphicsClipping | TextFormatFlags.PreserveGraphicsTranslateTransform;
            TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, e.TextRectangle, color, flags);
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            int y = e.Item.Bounds.Height / 2;
            using (var pen = new Pen(Color.FromArgb(230, 232, 238)))
                e.Graphics.DrawLine(pen, 14, y, e.Item.Width - 14, y);
        }

        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
        {
            var r = e.ImageRectangle;
            if (r.Width < 4 || r.Height < 4) r = new Rectangle(e.Item.ContentRectangle.X + 6, e.Item.ContentRectangle.Y + (e.Item.Height - 12) / 2, 12, 12);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var pen = new Pen(Color.FromArgb(79, 107, 255), 1.8f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                int x = r.Left + r.Width / 2;
                int y = r.Top + r.Height / 2;
                e.Graphics.DrawLines(pen, new[]
                {
                    new Point(x - 4, y),
                    new Point(x - 1, y + 3),
                    new Point(x + 5, y - 4),
                });
            }
        }

        static GraphicsPath RoundRect(Rectangle r, int radius)
        {
            var p = new GraphicsPath();
            int d = radius * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
    }

    sealed class TrayApp : ApplicationContext
    {
        readonly NotifyIcon notify;
        readonly Icon appIcon;
        readonly Bitmap brandImage;
        readonly Font menuFont;
        readonly Font headerFont;
        readonly ToolStripMenuItem autoItem;
        readonly ToolStripLabel statusItem;
        readonly System.Windows.Forms.Timer poll;
        int lastCount = -1;

        public TrayApp()
        {
            brandImage = LoadBrandBitmap();
            appIcon = LoadAppIcon();
            menuFont = MenuFont(FontStyle.Regular);
            headerFont = MenuFont(FontStyle.Bold);

            var menu = new ContextMenuStrip();
            menu.Font = menuFont;
            menu.Renderer = new CodeskMenuRenderer();
            menu.ShowImageMargin = false;
            menu.ShowCheckMargin = true;
            menu.Padding = new Padding(4, 6, 4, 6);
            menu.MinimumSize = new Size(228, 0);

            var header = new ToolStripLabel("Codesk Hub");
            header.Tag = "header";
            header.Font = headerFont;
            header.Padding = new Padding(10, 8, 12, 0);
            header.Margin = new Padding(0);
            if (brandImage != null)
            {
                header.Image = new Bitmap(brandImage, 16, 16);
                header.DisplayStyle = ToolStripItemDisplayStyle.ImageAndText;
                header.ImageAlign = ContentAlignment.MiddleLeft;
                header.TextAlign = ContentAlignment.MiddleLeft;
            }

            statusItem = new ToolStripLabel("运行中");
            statusItem.Tag = "status";
            statusItem.Padding = new Padding(brandImage != null ? 30 : 10, 0, 12, 8);
            statusItem.Margin = new Padding(0);

            autoItem = new ToolStripMenuItem("开机自启动");
            autoItem.Checked = AutoStartOn();
            autoItem.Click += (s, e) =>
            {
                var next = !AutoStartOn();
                SetAutoStart(next);
                autoItem.Checked = AutoStartOn();
            };

            var hostItem = new ToolStripMenuItem("打开主机台");
            hostItem.Click += (s, e) => OpenUrl(HostUrl);
            var workItem = new ToolStripMenuItem("打开工作台");
            workItem.Click += (s, e) => OpenUrl(AppUrl);
            var exitItem = new ToolStripMenuItem("退出 Hub");
            exitItem.Click += (s, e) => ExitThread();

            StyleItem(hostItem);
            StyleItem(workItem);
            StyleItem(autoItem);
            StyleItem(exitItem);

            menu.Items.Add(header);
            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(hostItem);
            menu.Items.Add(workItem);
            menu.Items.Add(autoItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            notify = new NotifyIcon
            {
                Icon = appIcon,
                Text = "Codesk Hub",
                Visible = true,
                ContextMenuStrip = menu,
            };
            notify.DoubleClick += (s, e) => OpenUrl(HostUrl);
            if (hubProc != null)
            {
                hubProc.EnableRaisingEvents = true;
                hubProc.Exited += (s, e) =>
                {
                    if (exiting) return;
                    try
                    {
                        if (notify.ContextMenuStrip != null && notify.ContextMenuStrip.IsHandleCreated)
                            notify.ContextMenuStrip.BeginInvoke(new Action(ExitThread));
                        else
                            ExitThread();
                    }
                    catch { }
                };
            }

            poll = new System.Windows.Forms.Timer { Interval = 2000 };
            poll.Tick += (s, e) => CheckClients();
            poll.Start();
            CheckClients();
        }

        static void StyleItem(ToolStripMenuItem item)
        {
            item.Padding = new Padding(10, 7, 18, 7);
            item.AutoSize = true;
        }

        void CheckClients()
        {
            try
            {
                var json = HttpGet("http://127.0.0.1:" + Port + "/api/host/clients");
                var count = ReadRemoteCount(json);
                if (lastCount >= 0 && count > lastCount)
                {
                    notify.BalloonTipTitle = "Codesk";
                    notify.BalloonTipText = "有设备连上了";
                    notify.ShowBalloonTip(4000);
                }
                lastCount = count;
                notify.Text = count > 0 ? "Codesk Hub · " + count + " 台已连接" : "Codesk Hub";
                statusItem.Text = count > 0 ? count + " 台设备已连接" : "运行中";
            }
            catch
            {
                statusItem.Text = "Hub 未响应";
            }
        }

        protected override void ExitThreadCore()
        {
            exiting = true;
            poll.Stop();
            notify.Visible = false;
            notify.Dispose();
            if (appIcon != null) appIcon.Dispose();
            if (brandImage != null) brandImage.Dispose();
            if (menuFont != null) menuFont.Dispose();
            if (headerFont != null) headerFont.Dispose();
            base.ExitThreadCore();
        }
    }
}
