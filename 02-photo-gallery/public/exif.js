// JPEG EXIF 에서 촬영 시각(DateTimeOriginal)을 읽는 작은 파서
//
// 서버가 아니라 브라우저에서 읽는 이유: Worker 의 무료 CPU 시간(호출당 10ms)을 아끼고,
// 업로드 전에 사용자에게 촬영일을 보여 줄 수 있기 때문입니다.
//
// JPEG 구조:  FFD8 | FFE1(APP1) 길이 "Exif\0\0" TIFF헤더 IFD0 … | … 
// TIFF 안의 IFD0 → ExifIFD(태그 0x8769) → DateTimeOriginal(0x9003) "YYYY:MM:DD HH:MM:SS"

/**
 * @param {File} file
 * @returns {Promise<number|null>} 촬영 시각(Unix 초). EXIF 는 시간대 정보가 없어서 이 브라우저의 시간대로 해석합니다.
 */
export async function readTakenAt(file) {
  if (file.type && file.type !== "image/jpeg") return null;
  try {
    // EXIF 는 파일 앞부분에 있으므로 앞 128KB 만 읽습니다.
    const view = new DataView(await file.slice(0, 128 * 1024).arrayBuffer());
    if (view.getUint16(0) !== 0xffd8) return null;

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset);
      const size = view.getUint16(offset + 2);
      if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966 /* "Exif" */) {
        return parseTiff(view, offset + 10);
      }
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda /* 이미지 데이터 시작 */) break;
      offset += 2 + size;
    }
  } catch {
    /* 깨진 EXIF 는 무시 */
  }
  return null;
}

function parseTiff(view, tiff) {
  const little = view.getUint16(tiff) === 0x4949; // "II" = 리틀 엔디언, "MM" = 빅 엔디언
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);

  /** IFD 하나에서 원하는 태그의 "값 위치"를 찾습니다. */
  const findTag = (ifd, tag) => {
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === tag) return entry;
    }
    return null;
  };
  const readAscii = (entry) => {
    const len = u32(entry + 4);
    const at = len > 4 ? tiff + u32(entry + 8) : entry + 8;
    let s = "";
    for (let i = 0; i < len - 1; i++) s += String.fromCharCode(view.getUint8(at + i));
    return s;
  };

  const ifd0 = tiff + u32(tiff + 4);
  let text = null;
  const exifPtr = findTag(ifd0, 0x8769);
  if (exifPtr) {
    const dto = findTag(tiff + u32(exifPtr + 8), 0x9003); // DateTimeOriginal
    if (dto) text = readAscii(dto);
  }
  if (!text) {
    const dt = findTag(ifd0, 0x0132); // DateTime (수정 시각) 으로 대체
    if (dt) text = readAscii(dt);
  }
  const m = text && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!m) return null;
  const date = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const sec = Math.floor(date.getTime() / 1000);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}
