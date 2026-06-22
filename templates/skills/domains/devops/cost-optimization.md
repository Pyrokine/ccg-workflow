---
name: cost-optimization
description: 成本优化秘典。FinOps框架、计算/存储/网络优化、成本建模。当用户提到成本、费用、FinOps、省钱、预算、账单时路由到此。
---

# 🔧 炼器秘典 · 成本优化

## FinOps 框架

```
┌─────────────────────────────────────┐
│           FinOps 生命周期            │
├───────────┬───────────┬─────────────┤
│  Inform   │  Optimize │  Operate    │
│  可视化   │  优化     │  运营       │
│  谁花了   │  怎么省   │  持续治理   │
│  多少钱   │  多少钱   │  流程制度   │
└───────────┴───────────┴─────────────┘
```

| 阶段       | 目标    | 关键动作                |
|----------|-------|---------------------|
| Inform   | 成本可视化 | 标签策略、成本分摊、Dashboard |
| Optimize | 降低浪费  | 右尺寸、预留、Spot、清理闲置    |
| Operate  | 持续治理  | 预算告警、审批流程、定期审查      |

---

## 成本分析

### 标签策略

```yaml
必选标签:
  - Environment: prod/staging/dev
  - Team: platform/backend/frontend
  - Service: order-service/user-service
  - Owner: team-email
  - CostCenter: CC-001

可选标签:
  - Project: project-name
  - Temporary: expiry-date
```

### 成本归因

```
总成本
├── 按团队: Team-A (40%) | Team-B (35%) | 共享 (25%)
├── 按环境: Prod (60%) | Staging (25%) | Dev (15%)
├── 按服务: 计算 (45%) | 存储 (25%) | 网络 (15%) | 其他 (15%)
└── 按类型: On-Demand (30%) | Reserved (50%) | Spot (10%) | 其他 (10%)
```

---

## 计算优化

### 右尺寸 (Right-sizing)

```bash
# AWS - 查找低利用率实例
aws ce get-rightsizing-recommendation \
  --service EC2 \
  --configuration '{"RecommendationTarget":"SAME_INSTANCE_FAMILY","BenefitsConsidered":true}'

# 判断标准
# CPU 平均 < 20% 且 峰值 < 50% → 缩小
# CPU 平均 > 70% 或 峰值 > 90% → 扩大
# Memory 使用 < 30% → 缩小
```

### 预留实例 / Savings Plans

| 类型                      | 折扣   | 灵活性 | 适用   |
|-------------------------|------|-----|------|
| Reserved Instance (1yr) | ~30% | 低   | 稳定负载 |
| Reserved Instance (3yr) | ~50% | 低   | 长期稳定 |
| Savings Plans (Compute) | ~30% | 高   | 跨实例族 |
| Savings Plans (EC2)     | ~40% | 中   | 固定区域 |

### Spot 实例

```yaml
适用场景:
  - 批处理任务
  - CI/CD 构建
  - 无状态 Web 服务（配合 ASG）
  - 大数据处理

不适用:
  - 数据库
  - 有状态服务
  - 长时间运行的关键任务

最佳实践:
  - 多实例类型混合
  - 跨可用区分散
  - 设置中断处理 (2分钟通知)
  - 配合 On-Demand 保底
```

### 自动伸缩

```yaml
# Target Tracking (推荐)
scaling_policy:
  type: TargetTrackingScaling
  target_value: 70          # CPU 目标 70%
  scale_in_cooldown: 300
  scale_out_cooldown: 60

# 预测性伸缩
predictive_scaling:
  mode: ForecastAndScale
  scheduling_buffer_time: 300

# 定时伸缩 (已知流量模式)
scheduled_actions:
  - schedule: "cron(0 8 * * MON-FRI)"   # 工作日早8点扩容
    min_capacity: 10
  - schedule: "cron(0 20 * * MON-FRI)"  # 晚8点缩容
    min_capacity: 2
```

---

## 存储优化

### 存储分层

| 层级              | 访问频率 | 成本  | 适用    |
|-----------------|------|-----|-------|
| S3 Standard     | 频繁   | $$$ | 活跃数据  |
| S3 IA           | 月级   | $$  | 备份、日志 |
| S3 Glacier      | 季度级  | $   | 归档    |
| S3 Glacier Deep | 年级   | ¢   | 合规归档  |

### 生命周期策略

```json
{
  "Rules": [
    {
      "ID": "log-lifecycle",
      "Filter": {"Prefix": "logs/"},
      "Transitions": [
        {"Days": 30, "StorageClass": "STANDARD_IA"},
        {"Days": 90, "StorageClass": "GLACIER"},
        {"Days": 365, "StorageClass": "DEEP_ARCHIVE"}
      ],
      "Expiration": {"Days": 2555}
    }
  ]
}
```

### 数据库存储

```yaml
优化策略:
  - 定期清理过期数据 (TTL/分区删除)
  - 压缩历史表
  - 归档冷数据到对象存储
  - 使用列式存储处理分析查询
  - 审查未使用的索引
```

---

## 网络优化

| 优化项         | 方法              | 节省         |
|-------------|-----------------|------------|
| 跨 AZ 流量     | 同 AZ 优先路由       | ~$0.01/GB  |
| 跨 Region 流量 | CDN + 边缘缓存      | ~$0.02/GB  |
| NAT Gateway | 使用 VPC Endpoint | ~$0.045/GB |
| 数据传输        | 压缩 + 批量         | 30-70%     |

```yaml
VPC Endpoint 优先:
  - S3: Gateway Endpoint (免费)
  - DynamoDB: Gateway Endpoint (免费)
  - 其他 AWS 服务: Interface Endpoint (按小时计费，但省流量费)
```

---

## 应用层优化

### 缓存降本

```
无缓存: 100% 请求打到数据库 → 需要大实例
加缓存: 80% 缓存命中 → 数据库可缩小 60%
```

### 架构降本

| 模式         | 场景     | 节省          |
|------------|--------|-------------|
| Serverless | 低流量/突发 | 按调用付费，空闲零成本 |
| 容器化        | 中等流量   | 提高资源利用率     |
| 队列削峰       | 突发流量   | 减少峰值资源需求    |
| 读写分离       | 读多写少   | 读副本用小实例     |

### 代码级降本

```yaml
减少外部调用:
  - 批量 API 调用替代循环单次
  - 本地缓存热数据
  - 连接池复用

减少计算:
  - 惰性计算
  - 增量处理替代全量
  - 合理的超时设置（避免资源空等）
```

---

## 成本建模

### 单位经济学

```
单用户成本 = 总基础设施成本 / 活跃用户数

目标: 随规模增长，单用户成本递减
```

### 成本预测

```yaml
输入:
  - 当前月成本: $10,000
  - 用户增长率: 20%/月
  - 基础设施弹性系数: 0.7 (成本增长 = 用户增长 × 0.7)

预测:
  - M+1: $10,000 × (1 + 0.2 × 0.7) = $11,400
  - M+3: ~$14,800
  - M+6: ~$22,100
```

---

## 成本优化清单

```yaml
即时见效 (Quick Wins):
  - [ ] 清理闲置资源 (未挂载 EBS、空闲 EIP、停止的实例)
  - [ ] 删除未使用的快照和 AMI
  - [ ] 右尺寸低利用率实例
  - [ ] 启用 S3 生命周期策略

中期优化:
  - [ ] 购买 Savings Plans / Reserved Instances
  - [ ] Spot 实例用于非关键负载
  - [ ] 配置自动伸缩
  - [ ] VPC Endpoint 替代 NAT Gateway

长期治理:
  - [ ] 标签策略 100% 覆盖
  - [ ] 成本分摊 Dashboard
  - [ ] 月度成本审查会议
  - [ ] 预算告警自动化
```

