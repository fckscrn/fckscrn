import zlib from "node:zlib";

// Tiny ZIP writer for test fixtures.
export function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const rel = (id, target, type = "x") => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
const notes = text => `<p:notes><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${text.split("\n").map(l => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>99</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`;

// 3 slides, the 2nd one hidden, 4:3, with a video
export function samplePptx() {
  return makeZip({
    "ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships>${rel("rId2", "slides/slide1.xml")}${rel("rId3", "slides/slide2.xml")}${rel("rId4", "/ppt/slides/slide3.xml")}</Relationships>`,
    "ppt/slides/slide1.xml": `<p:sld/>`,
    "ppt/slides/slide2.xml": `<p:sld show="0"/>`,
    "ppt/slides/slide3.xml": `<p:sld/>`,
    "ppt/slides/_rels/slide1.xml.rels": `<Relationships>${rel("rId1", "../notesSlides/notesSlide1.xml")}</Relationships>`,
    "ppt/slides/_rels/slide2.xml.rels": `<Relationships>${rel("rId1", "../notesSlides/notesSlide2.xml")}</Relationships>`,
    "ppt/slides/_rels/slide3.xml.rels": `<Relationships>${rel("rId1", "../notesSlides/notesSlide3.xml")}</Relationships>`,
    "ppt/notesSlides/notesSlide1.xml": notes("Pozdravit sál\nŘíct, kdo jsem &amp; proč"),
    "ppt/notesSlides/notesSlide2.xml": notes("skryté"),
    "ppt/notesSlides/notesSlide3.xml": notes("Díky"),
    "ppt/media/media1.mp4": "fake",
  });
}

export const samplePdf = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 960 540] >> endobj\n" +
  "3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n4 0 obj << /Type /Page /Parent 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");

// 16:9 deck, 3 slides: an embedded MP4 that starts on its own (slide 1), a YouTube video and a video
// linked to a file on the author's disk (slide 2), an embedded WMV the player can't play (slide 3)
const pic = (id, rid, x, y, cx, cy) => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Video ${id}"/><p:cNvPicPr/>
  <p:nvPr><a:videoFile r:link="${rid}"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"><a:extLst><a:ext uri="{X}"/></a:extLst></a:blip></p:blipFill>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr></p:pic>`;
const autoStart = spid => `<p:timing><p:tnLst><p:par><p:cTn id="1" nodeType="tmRoot"><p:childTnLst><p:seq><p:cTn id="2" nodeType="mainSeq"><p:childTnLst>
  <p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst>
  <p:par><p:cTn id="4" fill="hold"><p:childTnLst><p:par><p:cTn id="5" presetID="1" presetClass="mediacall" nodeType="afterEffect"><p:childTnLst>
  <p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr><p:cTn id="6" dur="1"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:cmd>
  </p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
export function videoPptx() {
  const W = 12192000, H = 6858000;
  return makeZip({
    "ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships>${rel("rId2", "slides/slide1.xml")}${rel("rId3", "slides/slide2.xml")}${rel("rId4", "slides/slide3.xml")}</Relationships>`,
    "ppt/slides/slide1.xml": `<p:sld><p:cSld><p:spTree>${pic(4, "rId2", W / 4, H / 4, W / 2, H / 2)}</p:spTree></p:cSld>${autoStart(4)}</p:sld>`,
    "ppt/slides/slide2.xml": `<p:sld><p:cSld><p:spTree>${pic(5, "rId2", 0, 0, W / 2, H / 2)}${pic(6, "rId3", W / 2, H / 2, W / 2, H / 2)}</p:spTree></p:cSld></p:sld>`,
    "ppt/slides/slide3.xml": `<p:sld><p:cSld><p:spTree>${pic(7, "rId2", 0, 0, W, H)}</p:spTree></p:cSld></p:sld>`,
    "ppt/slides/_rels/slide1.xml.rels": `<Relationships>${rel("rId2", "../media/media1.mp4")}</Relationships>`,
    "ppt/slides/_rels/slide2.xml.rels": `<Relationships><Relationship Id="rId2" Type="video" Target="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=10" TargetMode="External"/>
      <Relationship Id="rId3" Type="video" Target="file:///C:/Users/Jan/Videa/demo%20final.mp4" TargetMode="External"/></Relationships>`,
    "ppt/slides/_rels/slide3.xml.rels": `<Relationships>${rel("rId2", "../media/media2.wmv")}</Relationships>`,
    "ppt/media/media1.mp4": "fake mp4 bytes",
    "ppt/media/media2.wmv": "fake wmv",
  });
}
