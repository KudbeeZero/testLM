$ErrorActionPreference = "Continue"

Write-Host "=== FINAL VERIFICATION ==="

# Verify old role has no policies
Write-Host "Checking EC2-SSM-ROLE (old)..."
aws iam list-attached-role-policies --role-name EC2-SSM-ROLE --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\final-old-role.json"

# Verify no inline policies
Write-Host "Checking inline policies on old role..."
aws iam list-role-policies --role-name EC2-SSM-ROLE --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\final-inline.json"

# Verify new role policies
Write-Host "Checking EC2-SSM-MINIMAL (new) policies..."
aws iam list-attached-role-policies --role-name EC2-SSM-MINIMAL --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\final-new-role.json"

# Verify both instances use new profile
Write-Host "Verifying instance 1 profile..."
aws ec2 describe-instances --instance-ids i-0a8157bc8ea33b36b --query 'Reservations[0].Instances[0].IamInstanceProfile' --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\final-i1.json"

Write-Host "Verifying instance 2 profile..."
aws ec2 describe-instances --instance-ids i-0685561c90845986d --query 'Reservations[0].Instances[0].IamInstanceProfile' --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\final-i2.json"

Write-Host "=== VERIFICATION COMPLETE ==="