$ErrorActionPreference = "Continue"

Write-Host "=== PHASE 5: DETACH 15 POLICIES FROM EC2-SSM-ROLE ==="

$policies = @(
    "arn:aws:iam::aws:policy/AlexaForBusinessGatewayExecution",
    "arn:aws:iam::aws:policy/AlexaForBusinessDeviceSetup",
    "arn:aws:iam::aws:policy/AdministratorAccess-AWSElasticBeanstalk",
    "arn:aws:iam::aws:policy/AIOpsOperatorAccess",
    "arn:aws:iam::aws:policy/AIOpsAssistantPolicy",
    "arn:aws:iam::aws:policy/AIDevOpsAgentActionsPolicy",
    "arn:aws:iam::aws:policy/AIDevOpsOperatorAppAccessPolicy",
    "arn:aws:iam::aws:policy/AIOpsAssistantIncidentReportPolicy",
    "arn:aws:iam::aws:policy/AIDevOpsAgentReadOnlyAccess",
    "arn:aws:iam::aws:policy/AdministratorAccess-Amplify",
    "arn:aws:iam::aws:policy/AIDevOpsAgentAccessPolicy",
    "arn:aws:iam::aws:policy/AIOpsReadOnlyAccess",
    "arn:aws:iam::aws:policy/AgentRegistryReadOnlyAccess",
    "arn:aws:iam::aws:policy/AccountManagementFromVercel",
    "arn:aws:iam::aws:policy/service-role/AIDevOpsConstellationAccessPolicy"
)

$counter = 1
foreach ($policy in $policies) {
    Write-Host "Detaching policy $counter of 15: $policy"
    aws iam detach-role-policy --role-name EC2-SSM-ROLE --policy-arn $policy 2>&1 | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase5-detach-$counter.txt"
    $counter++
}

Write-Host "Verifying all policies detached..."
aws iam list-attached-role-policies --role-name EC2-SSM-ROLE --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase5-verify.json"

Write-Host "=== PHASE 5 COMPLETE ==="