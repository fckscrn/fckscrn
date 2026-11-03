// Fallback: start the original file in PowerPoint / Keynote.
// Used when there is no PDF (no converter on the server) or the talk needs video/animations.
const { execFile } = require("node:child_process");
const { shell } = require("electron");

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 30000 }, err => (err ? reject(err) : resolve())));

const asString = s => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

async function openNative(file, ext) {
  if (process.platform === "darwin") {
    try {
      if (ext === "key") {
        return await run("osascript", ["-e", `tell application "Keynote"
          activate
          set d to open POSIX file ${asString(file)}
          start d from first slide of d
        end tell`]);
      }
      if (ext === "pptx" || ext === "ppt") {
        return await run("osascript", ["-e", `tell application "Microsoft PowerPoint"
          activate
          open POSIX file ${asString(file)}
          delay 1
          run slide show slide show settings of active presentation
        end tell`]);
      }
    } catch {
      // app missing or scripting denied: fall back to just opening the file
    }
  }
  if (process.platform === "win32" && (ext === "pptx" || ext === "ppt")) {
    try { return await run("cmd", ["/c", "start", '""', "powerpnt", "/s", file]); } catch {}
  }
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
}

module.exports = { openNative };
