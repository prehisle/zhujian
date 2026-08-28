// Launch a process on a SEPARATE Windows desktop inside the CURRENT session.
//
// Why this exists: the Windows/WebView2 e2e run takes over the machine — its app windows
// grab focus and the developer cannot work while it runs (447 measured 5:22-10:28 per run,
// and CLAUDE.md carries a rule "do not run anything that opens a window in parallel").
// A second *user session* would fix it too, but creating one needs an interactive logon at
// LogonUI, which no program can do for you. A second *desktop* needs nothing from anyone:
// windows on it are invisible to (and cannot steal focus from) the default desktop, and the
// whole child process tree inherits it automatically via STARTUPINFO.lpDesktop.
//
// Compiled at runtime by Add-Type -Path. ASCII only on purpose (memory: powershell-utf8-readfile-trap).

using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WinDesktop
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktop(
        string lpszDesktop, IntPtr lpszDevice, IntPtr pDevmode,
        int dwFlags, uint dwDesiredAccess, IntPtr lpsa);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles,
        uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private const uint GENERIC_ALL = 0x10000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint INFINITE = 0xFFFFFFFF;

    // Returns the child's exit code when wait=true, otherwise its pid.
    // Throws with the raw Win32 error on failure -- fail loudly, never return a plausible zero.
    public static int Run(string desktop, string commandLine, string workingDir, bool wait)
    {
        IntPtr hDesktop = CreateDesktop(desktop, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (hDesktop == IntPtr.Zero)
            throw new Exception("CreateDesktop failed, Win32 error " + Marshal.GetLastWin32Error());

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        // The window station is always WinSta0 for an interactive session; only the desktop changes.
        si.lpDesktop = "WinSta0\\" + desktop;

        // CreateProcess may write into the command line buffer -> must be mutable (StringBuilder),
        // not a marshalled immutable string.
        StringBuilder cmd = new StringBuilder(commandLine, commandLine.Length + 1024);

        PROCESS_INFORMATION pi;
        bool started = CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false,
            CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, workingDir, ref si, out pi);
        if (!started)
            throw new Exception("CreateProcess failed, Win32 error " + Marshal.GetLastWin32Error());

        if (!wait)
        {
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return pi.dwProcessId;
        }

        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return (int)code;
    }
}
