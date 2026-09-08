#!/usr/bin/env bash
# Audit Rocket Science Project with Claude on AiPASS

PROJECT_DIR="/Users/ittmacair/Documents/08_Rocket Science Project"

echo "=========================================================="
echo "🚀 Rocket Science Code Audit via Claude (AiPASS Bridge)"
echo "=========================================================="

# Check if bridge is connected to Chrome Extension
STATUS=$(curl -s http://127.0.0.1:8787/status 2>/dev/null)
EXTENSIONS=$(echo "$STATUS" | grep -o '"extensions":[0-9]*' | cut -d':' -f2)

if [ -z "$EXTENSIONS" ] || [ "$EXTENSIONS" -eq 0 ]; then
  echo "⚠️ ยังไม่พบการเชื่อมต่อจาก Chrome Extension (extensions: 0)"
  echo ""
  echo "👉 กรุณาทำ 2 ขั้นตอนนี้ใน Chrome ก่อนเริ่ม:"
  echo "  1. เปิด chrome://extensions เปิด Developer mode แล้วกด 'Load unpacked'"
  echo "     เลือกโฟลเดอร์: /Users/ittmacair/Documents/03_Templates_and_Tools/Scripts_&_Code/aipass-bridge/aipass-bridge/extension"
  echo "  2. เปิดแท็บ https://de.aipass.net/chat แล้วล็อกอินทิ้งไว้"
  echo ""
  echo "หลังจากทำเสร็จแล้ว รันคำสั่งนี้ซ้ำได้ทันที: ./audit_with_claude.sh"
  exit 1
fi

echo "🟢 ตรวจพบ Chrome Extension เชื่อมต่อแล้ว (extensions: $EXTENSIONS)"
echo "🧠 กำลังส่งคำขอตรวจสอบโค้ดไปยัง Claude Sonnet (claude-sonnet-5@default)..."
echo "----------------------------------------------------------"

aipass agent "ตรวจเช็คโค้ดของโปรเจกต์ Rocket Science ทั้งหมด ตรวจสอบ Matching Logic, 50s rule, Concurrency Lock, Overdraft Protection, และ Error Handling พร้อมสรุปจุดที่ควรปรับปรุง" --root "$PROJECT_DIR" --model claude-sonnet-5@default
