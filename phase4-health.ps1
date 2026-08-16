$ErrorActionPreference = "Continue"

Write-Host "=== PHASE 4: VERIFY SSM & APPLICATION HEALTH ==="

# Check SSM instance manager status for both instances
Write-Host "Checking SSM status for instance 1..."
aws ssm describe-instance-information --filters Key=InstanceIds,Values=i-0a8157bc8ea33b36b --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase4-ssm1.json"

Write-Host "Checking SSM status for instance 2..."
aws ssm describe-instance-information --filters Key=InstanceIds,Values=i-0685561c90845986d --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase4-ssm2.json"

Write-Host "Checking SSM session manager connectivity for instance 1..."
aws ssm describe-instance-information --instance-information-filter-list key=InstanceIds,valueSet=i-0a8157bc8ea33b36b --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase4-ping1.json"

Write-Host "=== PHASE 4 COMPLETE ==="
