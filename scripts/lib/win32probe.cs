// Read-only Win32 probes for driving/inspecting the desktop app's real windows from PowerShell
// (used by scripts/wstate-probe.ps1). Everything here is a thin P/Invoke layer: enumerate the
// top-level windows of a pid, read WINDOWPLACEMENT / IsZoomed / GetWindowRect, read the monitor
// work area, and ShowWindow/MoveWindow to play the user's gestures (restore / maximize / minimize / drag).
//
// Why a separate file: WINDOWPLACEMENT.rcNormalPosition is the ONLY place Windows keeps "where the
// window goes back to when un-maximized", and nothing in tauri/tao exposes it. The window-state bugs
// fixed in 667 were all invisible without reading it (progress-log 667 has the before/after readings).
//
// Call Dpi() FIRST: PowerShell 5.1 is not DPI-aware, so without it every coordinate comes back
// virtualized (scaled down by the monitor's DPI) and nothing matches the state file (physical px).
//
// Compiled at runtime by Add-Type -Path. ASCII only on purpose (memory: powershell-utf8-readfile-trap).

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinProbe
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT minPos, maxPos; public RECT normalPos; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
    [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);

    public const int SW_SHOWNORMAL = 1, SW_SHOWMAXIMIZED = 3, SW_MINIMIZE = 6, SW_RESTORE = 9;

    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4. Must run before any window/DPI call in the process.
    public static bool Dpi() { return SetProcessDpiAwarenessContext(new IntPtr(-4)); }

    public static List<IntPtr> Windows(uint pid)
    {
        var list = new List<IntPtr>();
        EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    // The notebook window is the one whose title is exactly two UTF-16 units ("zhu jian"); the capture
    // and lightbox windows carry longer titles, the IME/shell helper windows carry none.
    public static IntPtr Notebook(uint pid)
    {
        foreach (var h in Windows(pid)) { if (GetWindowTextLengthW(h) == 2) return h; }
        return IntPtr.Zero;
    }

    public static WINDOWPLACEMENT Placement(IntPtr h)
    {
        var wp = new WINDOWPLACEMENT(); wp.length = Marshal.SizeOf(wp); GetWindowPlacement(h, ref wp); return wp;
    }

    public static string Describe(IntPtr h)
    {
        if (h == IntPtr.Zero) return "hwnd=0";
        RECT r; GetWindowRect(h, out r); RECT c; GetClientRect(h, out c);
        var wp = Placement(h);
        return string.Format("vis={0} zoomed={1} iconic={2} dpi={3} outer=({4},{5})-({6},{7}) {8}x{9} client={10}x{11} showCmd={12} normal=({13},{14})-({15},{16}) {17}x{18}",
            IsWindowVisible(h), IsZoomed(h), IsIconic(h), GetDpiForWindow(h), r.L, r.T, r.R, r.B, r.R - r.L, r.B - r.T, c.R, c.B, wp.showCmd,
            wp.normalPos.L, wp.normalPos.T, wp.normalPos.R, wp.normalPos.B, wp.normalPos.R - wp.normalPos.L, wp.normalPos.B - wp.normalPos.T);
    }

    public static string WorkArea(IntPtr h)
    {
        var m = MonitorFromWindow(h, 2 /* MONITOR_DEFAULTTONEAREST */);
        var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi); GetMonitorInfoW(m, ref mi);
        return string.Format("monitor=({0},{1})-({2},{3}) work=({4},{5})-({6},{7}) {8}x{9}", mi.rcMonitor.L, mi.rcMonitor.T, mi.rcMonitor.R, mi.rcMonitor.B,
            mi.rcWork.L, mi.rcWork.T, mi.rcWork.R, mi.rcWork.B, mi.rcWork.R - mi.rcWork.L, mi.rcWork.B - mi.rcWork.T);
    }
}
