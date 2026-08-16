$ErrorActionPreference = "Continue"

Write-Host "Verifying instance profiles..."

# Check instance 1
aws ec2 describe-instances --instance-ids i-0a8157bc8ea33b36b --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\verify-i1-full.json"

# Check instance 2
aws ec2 describe-instances --instance-ids i-0685561c90845986d --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\verify-i2-full.json"

Write-Host "Done"
