import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  // Skip middleware if no ACCESS_CODE is configured (development mode)
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) return NextResponse.next();

  // Skip the access-code validation and check endpoints
  if (
    request.nextUrl.pathname === "/api/validate-access" ||
    request.nextUrl.pathname === "/api/check-access"
  ) {
    return NextResponse.next();
  }

  // Check for valid access code cookie
  const cookie = request.cookies.get("tv-access-code")?.value;
  if (cookie !== accessCode) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
