const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parsePairUrl } = require("../src/library");
let resolveRoles, assignRole;
test.before(async () => ({ resolveRoles, assignRole } = await import("../renderer/roles.mjs")));

const laptop = { id: 1, primary: true, internal: true };
const projector = { id: 2, primary: false, internal: false };
const stageMonitor = { id: 3, primary: false, internal: false };

test("defaults: laptop controls, first external projects, second is speaker monitor", () => {
  assert.deepEqual(resolveRoles([laptop, projector, stageMonitor]), { 1: "ctrl", 2: "proj", 3: "spk" });
  assert.deepEqual(resolveRoles([laptop]), { 1: "ctrl" });
  // laptop + projector: the laptop is control and speaker monitor in one window
  assert.deepEqual(resolveRoles([projector, laptop]), { 1: "both", 2: "proj" });
});

test("control + speaker monitor only with exactly two screens", () => {
  // explicitly chosen control stays control
  assert.deepEqual(resolveRoles([laptop, projector], { 1: "ctrl" }), { 1: "ctrl", 2: "proj" });
  // saved "both" falls back to separate roles when a third screen shows up
  assert.deepEqual(resolveRoles([laptop, projector, stageMonitor], { 1: "both", 2: "proj" }), { 1: "ctrl", 2: "proj", 3: "spk" });
  // picking the speaker monitor elsewhere leaves the laptop as plain control
  const two = [laptop, projector];
  assert.deepEqual(resolveRoles(two, assignRole({}, two, 2, "spk")), { 1: "ctrl", 2: "spk" });
  // picking "both" takes control and speaker monitor away from the other screen
  assert.deepEqual(resolveRoles(two, assignRole({ 1: "spk", 2: "ctrl" }, two, 1, "both")), { 1: "both", 2: "proj" });
});

test("saved roles win and stay unique", () => {
  assert.deepEqual(resolveRoles([laptop, projector, stageMonitor], { 2: "spk", 3: "proj" }), { 1: "ctrl", 2: "spk", 3: "proj" });
  // two screens saved as projection: the first keeps it
  assert.deepEqual(resolveRoles([laptop, projector, stageMonitor], { 2: "proj", 3: "proj" }), { 1: "ctrl", 2: "proj", 3: "spk" });
});

test("assigning a role takes it away from the other screen", () => {
  const all = [laptop, projector, stageMonitor];
  const next = assignRole({}, all, 3, "proj");
  assert.deepEqual(resolveRoles(all, next), { 1: "ctrl", 2: "off", 3: "proj" });
});

test("string display ids (web player) keep their own role", () => {
  const all = [{ id: "a", primary: true, internal: true }, { id: "b" }, { id: "c" }];
  assert.deepEqual(resolveRoles(all, assignRole({}, all, "c", "proj")), { a: "ctrl", b: "off", c: "proj" });
});

test("pairing links", () => {
  assert.deepEqual(parsePairUrl(" https://fckscrn.example/p/abc_123 "), { server: "https://fckscrn.example", token: "abc_123" });
  assert.deepEqual(parsePairUrl("http://localhost:8080/p/x/"), { server: "http://localhost:8080", token: "x" });
  assert.equal(parsePairUrl("https://fckscrn.example/e/admin"), null);
  assert.equal(parsePairUrl("nonsense"), null);
});

let videos;
test.before(async () => (videos = await import("../renderer/videos.mjs")));

test("next click plays a waiting video first, then moves on; going back resets it", () => {
  const talk = { videos: [{ i: 0, page: 1, start: "auto", ready: true }, { i: 1, page: 2, start: "click", ready: true }, { i: 2, page: 3, start: "click", ready: false }] };
  const live = { page: 1, pages: 4, played: [] };
  assert.deepEqual(videos.showing(live, talk).map(v => v.i), [0]);
  videos.next(live, talk);
  assert.equal(live.page, 2);
  assert.deepEqual(videos.showing(live, talk), []);
  assert.equal(videos.waiting(live, talk).i, 1);
  videos.next(live, talk); // plays the video
  assert.deepEqual([live.page, videos.showing(live, talk).map(v => v.i)], [2, [1]]);
  videos.next(live, talk); // a video the room doesn't have never blocks the click
  videos.next(live, talk);
  assert.equal(live.page, 4);
  videos.goTo(live, 2);
  assert.equal(videos.waiting(live, talk).i, 1);
});

test("video sound: the technician's choice, else the projector's HDMI output, else default", () => {
  const devs = [{ deviceId: "default", label: "Výchozí - MacBook Pro Speakers" }, { deviceId: "a", label: "MacBook Pro Speakers" }, { deviceId: "b", label: "EPSON PJ" }];
  assert.equal(videos.pickSink(devs, null, "EPSON PJ"), "b");
  assert.equal(videos.pickSink(devs, null, "DELL U2720Q"), "");
  assert.equal(videos.pickSink(devs, { id: "a", label: "MacBook Pro Speakers" }, "EPSON PJ"), "a");
  assert.equal(videos.pickSink(devs, { id: "changed", label: "MacBook Pro Speakers" }), "a", "ids can change, the name stays");
  assert.equal(videos.pickSink(devs, { id: "x", label: "USB mixer" }), "");
});
