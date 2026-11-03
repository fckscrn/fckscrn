// Videos on slides (PDF mode). Shared by the desktop app (main process), the web player and the output windows.
// A video plays over its place on the PDF slide; the PDF shows the poster frame underneath.
//   start "auto"  → plays as soon as the slide is shown
//   start "click" → the next click (clicker, arrow key, phone) plays it instead of moving on
// talk.videos[].ready = the room can play it (file downloaded, or an online link)

export const slideVideos = (talk, page) => (talk?.videos || []).filter(v => v.page === page && v.ready);

/** Videos on screen right now. */
export const showing = (live, talk) => slideVideos(talk, live.page).filter(v => v.start === "auto" || (live.played || []).includes(v.i));

/** The video the next click starts, if any. */
export const waiting = (live, talk) => slideVideos(talk, live.page).find(v => v.start === "click" && !(live.played || []).includes(v.i)) || null;

export function goTo(live, page) {
  if (page === live.page) return;
  live.page = page;
  live.played = [];
  live.black = false;
}

/** "next": first a video waiting for a click on this slide, then the next slide. */
export function next(live, talk) {
  const v = waiting(live, talk);
  if (v) { live.played = [...(live.played || []), v.i]; live.black = false; }
  else if (live.page < live.pages) goTo(live, live.page + 1);
}

/**
 * Audio output for the videos: the technician's choice; otherwise the projector's own output
 * (HDMI audio carries the display's name), otherwise the system default ("").
 * @param devices [{ deviceId, label }] audio outputs
 * @param choice  { id, label } | null
 */
export function pickSink(devices, choice, projectorLabel) {
  const real = devices.filter(d => d.deviceId && !["default", "communications"].includes(d.deviceId));
  if (choice) return (real.find(d => d.deviceId === choice.id) || real.find(d => d.label && d.label === choice.label))?.deviceId || "";
  const name = String(projectorLabel || "").toLowerCase().trim();
  if (name.length < 3) return "";
  return real.find(d => d.label && (d.label.toLowerCase().includes(name) || name.includes(d.label.toLowerCase())))?.deviceId || "";
}
