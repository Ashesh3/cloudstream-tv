import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { code } = await request.json();
  const accessCode = process.env.ACCESS_CODE;

  if (!accessCode) {
    // No access code configured, allow everything
    return NextResponse.json({ valid: true });
  }

  if (code !== accessCode) {
    return NextResponse.json(
      { valid: false, error: "Invalid access code" },
      { status: 403 }
    );
  }

  const response = NextResponse.json({ valid: true });
  response.cookies.set("tv-access-code", code, {
    path: "/",
    maxAge: 365 * 24 * 60 * 60, // 1 year
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
