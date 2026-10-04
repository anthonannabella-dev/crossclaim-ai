/**
 * UI 渲染测试用的 Next 运行时替身（仅测试注入，不参与生产构建）：
 * 让纯展示组件可以在 Node 里用 react-dom/server 渲染并断言。
 */
import type { ReactNode } from 'react';

export default function Link(props: {
  href: string;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  [key: string]: unknown;
}) {
  const { href, children, className, onClick } = props;
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
