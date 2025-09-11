import { google } from 'googleapis';

const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

export default async function handler(req, res) {
  try {
    const auth = new google.auth.JWT(
      GOOGLE_CLIENT_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    const sheets = google.sheets({ version: 'v4', auth });

    const row = [
      new Date().toISOString(),
      "TEST_ORDER",
      "1.23",
      "200",
      "Sí",
      "VISA",
      "724",
      "C",
      "test-merchantdata",
      "Tester",
      "tester@example.com"
    ];

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Pagos!A:Z',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    console.log("✅ Test row added", response.data.updates);
    res.status(200).json({ ok: true, updates: response.data.updates });
  } catch (err) {
    console.error("❌ Error writing test row", err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
