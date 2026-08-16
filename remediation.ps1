$aws = "C:\Users\domin\AppData\Local\Programs\Amazon\AWSCLIV2\aws.exe"
$trustPol = Get-Content -Raw "c:\Users\domin\Downloads\testLM\trust-policy.json"

# Phase 1: Create role
Write-Host "Creating EC2-SSM-MINIMAL role..."
& $aws iam create-role --role-name EC2-SSM-MINIMAL --assume-role-policy-document $trustPol --output json | Out-File "c:\Users\domin\Downloads\testLM\phase1-role.json"

# Attach policy
Write-Host "Attaching AmazonSSMManagedInstanceCore..."
& $aws iam attach-role-policy --role-name EC2-SSM-MINIMAL --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

# Create instance profile
Write-Host "Creating EC2-SSM-MINIMAL instance profile..."
& $aws iam create-instance-profile --instance-profile-name EC2-SSM-MINIMAL --output json | Out-File "c:\Users\domin\Downloads\testLM\phase1-profile.json"

# Add role to profile
Write-Host "Adding role to instance profile..."
& $aws iam add-role-to-instance-profile --instance-profile-name EC2-SSM-MINIMAL --role-name EC2-SSM-MINIMAL

Write-Host "Phase 1 complete"
