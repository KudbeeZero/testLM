$ErrorActionPreference = "Continue"

# Create role using direct AWS CLI call
Write-Host "Phase 1: Creating EC2-SSM-MINIMAL role"
aws iam create-role --role-name EC2-SSM-MINIMAL --assume-role-policy-document 'file://c:\Users\domin\Downloads\testLM\trust-policy.json' 2>&1 | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase1-role-output.txt"

Write-Host "Phase 1b: Attaching policy"
aws iam attach-role-policy --role-name EC2-SSM-MINIMAL --policy-arn 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore' 2>&1 | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase1-policy-output.txt"

Write-Host "Phase 1c: Creating instance profile"
aws iam create-instance-profile --instance-profile-name EC2-SSM-MINIMAL 2>&1 | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase1-profile-output.txt"

Write-Host "Phase 1d: Adding role to profile"
aws iam add-role-to-instance-profile --instance-profile-name EC2-SSM-MINIMAL --role-name EC2-SSM-MINIMAL 2>&1 | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase1-add-output.txt"

Write-Host "Phase 1 complete"
