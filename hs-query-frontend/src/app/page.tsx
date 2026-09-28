"use client";

import { useState, useCallback } from "react";
import { Search, Loader2, ExternalLink, TrendingUp, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface HsRecord {
  code: string;
  name: string;
  unit: string;
  mfn_rate: number;
  export_rate: number;
  vat_rate: number;
  excise_rate: number;
  supervision: string;
  chapter: string;
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HsRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasSearched, setHasSearched] = useState(false);

  const searchHs = useCallback(async (searchQuery: string) => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;

    setLoading(true);
    setError("");

    try {
      const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
      const res = await fetch(`${apiBase}/api/hscode/public/search?keyword=${encodeURIComponent(trimmed)}`);

      if (!res.ok) {
        if (res.status === 404) {
          setResults([]);
          setError("未找到匹配的HS编码，请尝试其他关键词");
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
        setHasSearched(true);
        return;
      }

      const json = await res.json();
      const data = json.data || json.results || json || [];
      setResults(Array.isArray(data) ? data : []);
      if (Array.isArray(data) && data.length === 0) {
        setError("未找到匹配的HS编码，请尝试其他关键词");
      }
    } catch (e) {
      setError("查询失败，请确认后端服务已启动");
    } finally {
      setLoading(false);
      setHasSearched(true);
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") searchHs(query);
  };

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="border-b bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-6 w-6 text-primary" />
            <span className="font-bold text-lg text-primary">报关合规SaaS</span>
          </div>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <span>HS编码查询</span>
            <span>RCEP税率</span>
            <span>原产地判定</span>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="bg-gradient-to-b from-primary/10 via-primary/5 to-slate-50 py-16">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl mb-3">
            HS 编码智能查询
          </h1>
          <p className="text-lg text-muted-foreground mb-8">
            输入商品名称或HS编码，获取MFN税率、FTA优惠税率及监管条件
          </p>

          <div className="flex gap-2 max-w-xl mx-auto">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入商品名称，如：锂电池、光伏电池、集成电路..."
                className="pl-10 h-11 text-base shadow-sm"
                disabled={loading}
              />
            </div>
            <Button
              size="lg"
              onClick={() => searchHs(query)}
              disabled={loading || !query.trim()}
              className="h-11 px-6 shadow-sm"
            >
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "查询"}
            </Button>
          </div>

          <div className="flex gap-4 justify-center mt-4 text-xs text-muted-foreground">
            <span>示例: 锂电池</span>
            <span>示例: 光伏组件</span>
            <span>示例: 集成电路</span>
            <span>示例: 8471.30</span>
          </div>
        </div>
      </section>

      {/* Results */}
      <main className="flex-1 max-w-6xl mx-auto px-4 py-8 w-full">
        {loading && (
          <div className="flex flex-col items-center py-20 gap-3">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <p className="text-muted-foreground">正在查询海关数据库...</p>
          </div>
        )}

        {error && hasSearched && !loading && (
          <Card className="border-destructive/30">
            <CardContent className="py-8 text-center text-destructive">{error}</CardContent>
          </Card>
        )}

        {results.length > 0 && !loading && (
          <Tabs defaultValue="table" className="w-full">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-muted-foreground">
                找到 <strong className="text-foreground">{results.length}</strong> 条结果
              </p>
              <TabsList>
                <TabsTrigger value="table">表格视图</TabsTrigger>
                <TabsTrigger value="cards">卡片视图</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="table">
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[130px]">HS 编码</TableHead>
                      <TableHead>商品名称</TableHead>
                      <TableHead className="w-[70px]">单位</TableHead>
                      <TableHead className="w-[90px]">MFN税率</TableHead>
                      <TableHead className="w-[90px]">出口税率</TableHead>
                      <TableHead className="w-[80px]">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((item) => (
                      <TableRow key={item.code}>
                        <TableCell className="font-mono font-medium">{item.code}</TableCell>
                        <TableCell>{item.name}</TableCell>
                        <TableCell>{item.unit || "-"}</TableCell>
                        <TableCell>
                          <Badge variant={item.mfn_rate > 0 ? "secondary" : "outline"}>
                            {item.mfn_rate > 0 ? `${item.mfn_rate}%` : "0%"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={item.export_rate > 0 ? "destructive" : "outline"}>
                            {item.export_rate > 0 ? `${item.export_rate}%` : "0%"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => window.open(`https://www.hscode.net/search?q=${item.code}`, "_blank")}
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </TabsContent>

            <TabsContent value="cards">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {results.map((item) => (
                  <Card key={item.code} className="hover:shadow-md transition-shadow">
                    <CardHeader className="pb-2">
                      <CardTitle className="font-mono text-lg text-primary">{item.code}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <p className="font-medium">{item.name}</p>
                      <div className="flex gap-2">
                        <Badge variant="secondary">MFN: {item.mfn_rate}%</Badge>
                        {item.export_rate > 0 && <Badge variant="destructive">出口: {item.export_rate}%</Badge>}
                        <Badge variant="outline">{item.unit}</Badge>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        )}

        {/* Empty state — only show when no results and no error */}
        {!hasSearched && !loading && (
          <div className="flex flex-col items-center py-16 text-center">
            <div className="grid grid-cols-3 gap-4 max-w-lg">
              <Card className="text-center">
                <CardContent className="pt-6 pb-4">
                  <Search className="h-6 w-6 mx-auto mb-2 text-primary" />
                  <p className="text-xs text-muted-foreground">输入商品名称<br />智能匹配HS编码</p>
                </CardContent>
              </Card>
              <Card className="text-center">
                <CardContent className="pt-6 pb-4">
                  <TrendingUp className="h-6 w-6 mx-auto mb-2 text-primary" />
                  <p className="text-xs text-muted-foreground">对比MFN与FTA<br />优惠税率差异</p>
                </CardContent>
              </Card>
              <Card className="text-center">
                <CardContent className="pt-6 pb-4">
                  <Shield className="h-6 w-6 mx-auto mb-2 text-primary" />
                  <p className="text-xs text-muted-foreground">查看监管条件<br />与检验检疫要求</p>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t bg-white py-6 text-center text-xs text-muted-foreground">
        <p>报关合规SaaS — 数据来源：海关总署信息公开栏目</p>
        <p className="mt-1">仅供参考，实际税率以海关最新公告为准</p>
      </footer>
    </div>
  );
}
