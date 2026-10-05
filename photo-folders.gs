// 사진 폴더 이름 목록을 돌려주는 Apps Script (드라이브 폴더 소유 계정으로 배포)
// 배포: 새 Apps Script 프로젝트 → 이 코드 붙여넣기 → 배포 > 새 배포 > 웹 앱
//       실행 계정: 나 / 액세스: 모든 사용자 → 나온 /exec 주소를 photo-checklist.html 의 PHOTO_FOLDER_URL 에 넣기
const FOLDER_ID = '1I-k3uHxZOnAXo3GJ8y6eWuZzxEPWzfb6';

function doGet() {
  const it = DriveApp.getFolderById(FOLDER_ID).getFolders();
  const folders = [];
  while (it.hasNext()) {
    const f = it.next();
    folders.push({ name: f.getName(), hasFiles: f.getFiles().hasNext() });
  }
  return ContentService.createTextOutput(JSON.stringify({ folders }))
    .setMimeType(ContentService.MimeType.JSON);
}
