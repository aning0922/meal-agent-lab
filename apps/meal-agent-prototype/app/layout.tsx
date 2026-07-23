import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Meal Agent · 低保真原型";
const description =
  "覆盖登录恢复、首次引导、库存批次、菜单组合、共享采购、同页餐后确认、我的与上下文 Agent 的完整 P0 技术验证产品基线。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [
        {
          url: imageUrl,
          width: 1731,
          height: 909,
          alt: "Meal Agent 家庭餐食闭环低保真原型",
        },
      ],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
