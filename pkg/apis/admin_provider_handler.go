package apis

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"simple-one-api/pkg/handler"
)

func AdminProviderTestHandler(c *gin.Context) {
	var draft handler.ProviderProbe
	if err := c.ShouldBindJSON(&draft); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "测试配置格式无效，请检查填写内容。"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, handler.ProbeProvider(c.Request.Context(), draft))
}
