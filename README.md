# SuggestBook

가족별 주간 추천도서를 보여주고, 읽은 책을 체크해 다음 추천에서 제외하는 Vite + React 앱입니다.

## 현재 기능

- 이레·이설·시아: 주간 추천 20권씩
- 부모 추천 1·2: 주간 추천 5권씩
- 읽은 책 체크 및 복원
- 체크한 책은 해당 프로필의 다음 추천에서 제외
- 브라우저 `localStorage` 저장
- 주차별 추천 순서 변경
- 제목·저자·주제 검색
- 텔레그램 알림 API와 매주 일요일 오전 9시(KST) Vercel Cron 구성

## 텔레그램 환경변수

Vercel 프로젝트 Settings → Environment Variables에 다음 값을 추가합니다.

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `APP_URL` = `https://suggestbook.vercel.app`

설정 후 다시 배포하면 매주 일요일 오전 9시(KST)에 알림이 발송됩니다.

## 향후 연결 지점

- 인기대출도서 API
- 수동 업로드 신착도서 CSV/XLSX
- 가족 공용 독서기록 DB
- 도서관 소장 여부 및 공식 검색 링크

## 개인정보 및 공개 설정

소스 저장소와 Vercel Deployment Protection은 각 서비스의 프로젝트 설정에서 비공개로 전환해야 합니다. 비밀키는 코드에 직접 넣지 않고 반드시 Vercel 환경변수로 관리합니다.
