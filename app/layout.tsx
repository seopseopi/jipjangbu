import type { Metadata } from "next";
import "./application.css";

export const metadata: Metadata = {
  title: "집장부 | 부동산 업무관리",
  description: "업무일지, 매물, 고객, 일정을 한곳에 쌓아 관리하는 부동산 업무 장부입니다.",
  icons: { icon: "/jipjangbu-icon-bright.png?v=20261031-renewal", shortcut: "/jipjangbu-icon-bright.png?v=20261031-renewal", apple: "/jipjangbu-icon-bright.png?v=20261031-renewal" },
  openGraph: { title: "집장부", description: "부동산 업무를 한곳에", siteName: "집장부", type: "website" },
  twitter: { card: "summary", title: "집장부", description: "부동산 업무를 한곳에" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
