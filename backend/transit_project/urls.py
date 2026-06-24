"""
URL configuration for transit_project project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.0/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path
from django.views.decorators.csrf import csrf_exempt
from strawberry.django.views import GraphQLView
from transit_app.schema import schema

urlpatterns = [
    path('admin/', admin.site.urls),
    # csrf_exempt: el frontend React hace POST sin token CSRF (es una API GraphQL
    # pública de solo lectura). Sin esto, Django responde 403 Forbidden a toda consulta.
    path('graphql/', csrf_exempt(GraphQLView.as_view(schema=schema))),
]

