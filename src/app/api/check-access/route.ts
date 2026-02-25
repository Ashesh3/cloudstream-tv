import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const accessCode = process.env.ACCESS_CODE;

  // No access code configured — everything is open
  if (!accessCode) {
    return NextResponse.json({ authenticated: true });
  }

  const cookie = request.cookies.get("tv-access-code")?.value;
  return NextResponse.json({ authenticated: cookie === accessCode });
}
