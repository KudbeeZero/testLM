$ErrorActionPreference = "Continue"

Write-Host "=== PHASE 2: VERIFY NEW ROLE/PROFILE ==="

# Verify role exists and check trust policy
Write-Host "Checking EC2-SSM-MINIMAL role..."
aws iam get-role --role-name EC2-SSM-MINIMAL --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\verify-role.json"

# Verify attached policies
Write-Host "Checking attached policies..."
aws iam list-attached-role-policies --role-name EC2-SSM-MINIMAL --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\verify-policies.json"

# Verify instance profile
Write-Host "Checking instance profile..."
aws iam get-instance-profile --instance-profile-name EC2-SSM-MINIMAL --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\verify-profile.json"

Write-Host "=== PHASE 2 COMPLETE ==="
