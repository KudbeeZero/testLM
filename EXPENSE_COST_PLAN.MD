# AWS Expense & Cost Plan

**Generated:** 2026-08-12T10:11:15-05:00  
**Account:** 196856329692  
**Region:** us-east-1  
**Billing Period:** 2026-08-01 to 2026-08-13  

---

## Active AWS Resources

### EC2 Instances

| Instance ID | Name | Type | Public IP | Private IP | State | AZ | Launch Time |
|:---|:---|:---|:---|:---|:---|:---|:---|
| i-0a8157bc8ea33b36b | thinnk-v1 | t3.micro | 32.195.66.72 | 172.31.15.22 | running | us-east-1a | 2026-08-12T14:19:03+00:00 |
| i-0685561c90845986d | (unnamed) | t3.micro | 100.27.48.223 | 172.31.3.136 | running | us-east-1a | 2026-08-12T14:19:03+00:00 |

**Free Tier Status:** t3.micro is eligible for 750 hours/month free tier. 2 instances running 24/7 = 48 hours/day. Free tier covers ~15.6 days. Risk of charges after ~Aug 28 if not stopped.

### EBS Volumes

| Volume ID | Size | Type | IOPS | Throughput | Attached To | DeleteOnTermination |
|:---|:---|:---|:---|:---|:---|:---|
| vol-01503fed90140f03a | 8 GB | gp3 | 3000 | 125 MB/s | i-0a8157bc8ea33b36b | True |
| vol-087a0c0f03d5c9b4d | 8 GB | gp3 | 3000 | 125 MB/s | i-0685561c90845986d | True |

**Free Tier Status:** 30 GB/month gp2/gp3 free tier. Current usage: 16 GB. Safe for now.

### RDS Instances

| Instance ID | Engine | Class | Status | Public | Endpoint | Storage | Type | Created |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| think-db-1-instance-1 | aurora-postgresql 18.4 | db.serverless | available | False | think-db-1-instance-1.cy7q8q6a2660.us-east-1.rds.amazonaws.com:5432 | 1 GB | aurora | 2026-08-12T14:58:34+00:00 |

**Free Tier Status:** Aurora Serverless is **NOT** free tier eligible. This is the highest risk for charges. Even minimal usage incurs costs.

### Load Balancers
None detected.

### ElastiCache
None detected.

### Lightsail
None detected.

---

## Cost Summary

| Service | Estimated Monthly Cost | Free Tier Coverage | Risk Level |
|:---|---:|:---|:---|
| EC2 (2x t3.micro 24/7) | ~-20 | 750 hrs free (partial) | Medium |
| EBS (2x 8GB gp3) | ~-2 | 30 GB free | Low |
| RDS Aurora Serverless | ~-30+ | **NOT covered** | **HIGH** |
| Data Transfer | Variable | 100 GB free | Low-Medium |
| **TOTAL** | **~-52+/month** | Partial | **Medium-High** |

**Note:** Cost Explorer shows  for Aug 1-12. This may mean billing has not caught up yet, or resources were launched mid-cycle. Verify in ~24 hours.

---

## Cost Reduction Plan

### Immediate Actions (Today)

1. **Terminate or stop unnamed EC2 instance** i-0685561c90845986d if not needed
2. **Stop 	hinnk-v1** when not in active use
3. **Evaluate Aurora Serverless** — if not actively used, pause or delete 	hink-db-1-instance-1

### Short-Term (This Week)

4. **Schedule EC2 stop/start** — use Lambda + CloudWatch Events to stop instances overnight
5. **Move to gp2** if gp3 throughput not needed (slightly cheaper)
6. **Review Upstash usage** — ensure local development uses local Postgres, not AWS RDS

### Long-Term (This Month)

7. **Consolidate to 1 EC2** if both instances serve the same purpose
8. **Consider Lightsail** for fixed-cost predictable billing if EC2/RDS proves complex
9. **Set up AWS Budgets** alert at , ,  thresholds
10. **Review free tier eligibility** for all services before next billing cycle

---

## Action Items

- [ ] Verify current charges in AWS Cost Explorer after 24h
- [ ] Confirm whether i-0685561c90845986d is needed
- [ ] Decide: pause or delete Aurora Serverless?
- [ ] Set up AWS Budgets alerts
- [ ] Document which services are essential vs. can be stopped

---

## Local Secrets Hygiene

**No hardcoded secrets were found in this audit.** The repo uses .env files and environment variables. Ensure:
- .env remains gitignored
- grok.env.example contains only placeholders
- AWS credentials stay in AWS CLI config, not in source code
